import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

import { formatError, logError, logSuccess } from '../shared/console-style.mjs'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(TEST_DIR, '..', '..')
const DIAGNOSTICS_SOURCE = path.join(PLUGIN_ROOT, 'src', 'diagnostics.ts')
const TEST_OUTPUT_DIR = path.join(PLUGIN_ROOT, 'test', 'output')

async function loadDiagnosticsModule() {
  const result = await build({
    absWorkingDir: PLUGIN_ROOT,
    entryPoints: [DIAGNOSTICS_SOURCE],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
    external: ['koishi', 'puppeteer-core'],
  })
  assert.equal(result.outputFiles.length, 1)

  const filename = path.join(TEST_DIR, '.diagnostics.bundle.cjs')
  const requireFromPlugin = createRequire(path.join(PLUGIN_ROOT, 'package.json'))
  const compiledModule = { exports: {} }
  const executeBundle = new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    result.outputFiles[0].text,
  )
  executeBundle(
    requireFromPlugin,
    compiledModule,
    compiledModule.exports,
    filename,
    TEST_DIR,
  )
  return compiledModule.exports
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, 'utf8'))
}

async function main() {
  const { CaptureDiagnostics } = await loadDiagnosticsModule()
  assert.equal(typeof CaptureDiagnostics, 'function')

  await mkdir(TEST_OUTPUT_DIR, { recursive: true })
  const baseDir = await mkdtemp(path.join(TEST_OUTPUT_DIR, 'diagnostics-'))
  const consoleLines = []
  const ctx = {
    baseDir,
    logger() {
      return {
        info(message) {
          consoleLines.push(String(message))
        },
        warn(message) {
          consoleLines.push(String(message))
        },
      }
    },
  }
  const config = {
    verboseConsoleLog: true,
    verboseFileLog: true,
    verboseFileLogRetention: 2,
  }

  try {
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      const diagnostics = new CaptureDiagnostics(ctx, 'status', config, { sequence })
      diagnostics.startAttempt(1)
      diagnostics.event('page.navigate.ok', '导航完成', { sequence })
      await diagnostics.persistSuccess(Buffer.from(`success-${sequence}`), 'png', { sequence })
    }

    const statusDir = path.join(
      baseDir,
      'cache',
      'check-sub2api-status',
      'diagnostics',
      'status',
    )
    const successHistoryDir = path.join(statusDir, 'success')
    const successJsonFiles = (await readdir(successHistoryDir))
      .filter(filename => filename.endsWith('.json'))
    assert.equal(successJsonFiles.length, 2, 'success history should obey retention')
    assert.equal(await readFile(path.join(statusDir, 'latest-success.png'), 'utf8'), 'success-3')
    const latestInitialSuccess = await readJson(path.join(statusDir, 'latest-success.json'))
    assert.equal(latestInitialSuccess.details.sequence, 3)

    const diagnostics = new CaptureDiagnostics(ctx, 'status', config, { scenario: 'retry' })
    diagnostics.startAttempt(1)
    const failurePage = {
      async screenshot() {
        return Buffer.from('failure-page')
      },
    }
    await diagnostics.persistFailure(
      new Error(
        'Bearer top-secret eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature rt_abcdefghijklmnop',
      ),
      failurePage,
      'png',
      86,
      { retryEligible: true },
    )
    diagnostics.event('capture.retry', '准备重试')
    diagnostics.startAttempt(2)
    await diagnostics.persistSuccess(Buffer.from('recovered-success'), 'png', { recovered: true })

    const latestFailure = await readJson(path.join(statusDir, 'latest-failure.json'))
    assert.equal(latestFailure.recoveredByRetry, true)
    assert.equal(latestFailure.details.recoveredByAttempt, 2)
    assert.equal(latestFailure.artifacts.imageCaptured, true)
    assert.equal(await readFile(path.join(statusDir, 'latest-failure.png'), 'utf8'), 'failure-page')
    assert.doesNotMatch(latestFailure.error.message, /top-secret|eyJ|rt_abcdefghijklmnop/u)
    assert.match(latestFailure.error.message, /REDACTED/u)

    const latestRecoveredSuccess = await readJson(path.join(statusDir, 'latest-success.json'))
    assert.equal(latestRecoveredSuccess.previousAttemptFailed, true)
    assert.equal(latestRecoveredSuccess.attempt, 2)
    assert.equal(await readFile(path.join(statusDir, 'latest-success.png'), 'utf8'), 'recovered-success')

    // A slower recovered capture must not overwrite a newer concurrent latest-failure record.
    const concurrentA = new CaptureDiagnostics(ctx, 'status', config, { concurrent: 'A' })
    concurrentA.startAttempt(1)
    await concurrentA.persistFailure(
      new Error('failure A'),
      failurePage,
      'png',
      86,
      { concurrent: 'A' },
    )
    const concurrentB = new CaptureDiagnostics(ctx, 'status', config, { concurrent: 'B' })
    concurrentB.startAttempt(1)
    await concurrentB.persistFailure(
      new Error('failure B'),
      failurePage,
      'png',
      86,
      { concurrent: 'B' },
    )
    concurrentA.startAttempt(2)
    await concurrentA.persistSuccess(Buffer.from('success A'), 'png', { concurrent: 'A' })

    const concurrentLatestFailure = await readJson(path.join(statusDir, 'latest-failure.json'))
    assert.equal(concurrentLatestFailure.captureId, concurrentB.captureId)
    assert.equal(concurrentLatestFailure.recoveredByRetry, false)
    const failureHistoryDir = path.join(statusDir, 'failure')
    const failurePayloads = await Promise.all(
      (await readdir(failureHistoryDir))
        .filter(filename => filename.endsWith('.json'))
        .map(filename => readJson(path.join(failureHistoryDir, filename))),
    )
    const recoveredA = failurePayloads.find(payload => payload.captureId === concurrentA.captureId)
    assert.equal(recoveredA?.recoveredByRetry, true)
    assert.equal(failurePayloads.length, 2, 'failure history should obey retention independently')
    assert.ok(consoleLines.some(line => line.includes('capture.success')))
    assert.ok(consoleLines.some(line => line.includes('capture.failure')))
  } finally {
    await rm(baseDir, { recursive: true, force: true })
  }

  logSuccess('diagnostics：全部检查通过')
}

main().catch((error) => {
  logError('diagnostics：检查失败', formatError(error))
  process.exitCode = 1
})
