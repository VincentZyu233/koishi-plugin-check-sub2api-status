import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

import { formatError, logError } from '../shared/console-style.mjs'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(TEST_DIR, '..', '..')
const ENTRY_FILES = {
  status: path.join(TEST_DIR, 'status-screenshot.test.ts'),
  trend: path.join(TEST_DIR, 'trend-screenshot.test.ts'),
}

async function loadTestEntry(kind) {
  const entryPoint = ENTRY_FILES[kind]
  if (!entryPoint) {
    throw new Error(`不支持的实拍测试类型：${kind || '(empty)'}`)
  }

  const result = await build({
    absWorkingDir: PLUGIN_ROOT,
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    write: false,
    logLevel: 'silent',
  })
  assert.equal(result.outputFiles.length, 1, 'esbuild should return one in-memory bundle')

  const filename = path.join(TEST_DIR, `.${kind}-screenshot-test.bundle.cjs`)
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

const [kind, ...args] = process.argv.slice(2)

try {
  const testEntry = await loadTestEntry(kind)
  assert.equal(typeof testEntry.run, 'function', `${kind} test entry should export run()`)
  await testEntry.run(args)
} catch (error) {
  logError('实拍测试启动失败：', formatError(error))
  process.exitCode = 1
}
