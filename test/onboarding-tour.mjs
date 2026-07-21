import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(TEST_DIR, '..')
const PUPPETEER_SOURCE = path.join(PLUGIN_ROOT, 'src', 'puppeteer.ts')

/**
 * src/puppeteer.ts is TypeScript and the plugin only emits declaration files during tsc.
 * Bundle it in memory so this regression test always exercises the current source without
 * creating temp/*.cjs artifacts. External runtime dependencies resolve from package.json.
 */
async function loadScreenshotModule() {
  const result = await build({
    absWorkingDir: PLUGIN_ROOT,
    entryPoints: [PUPPETEER_SOURCE],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
    external: [
      'koishi',
      'koishi-plugin-puppeteer',
      'puppeteer-core',
    ],
  })

  assert.equal(result.outputFiles.length, 1, 'esbuild should return one in-memory bundle')

  const filename = path.join(TEST_DIR, '.onboarding-tour.bundle.cjs')
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

/**
 * Keep the fixture small but representative of a freshly exported administrator session.
 * No real token, user information, network address, or local auth file is used by this test.
 */
function makeConfig(overrides = {}) {
  return {
    sub2apiBaseUrl: 'http://127.0.0.1:8080',
    authStateJson: JSON.stringify({
      origin: 'http://127.0.0.1:8080',
      userAgent: 'Exported-UA/1.0',
      localStorage: {
        auth_token: 'test-token',
        refresh_token: 'test-refresh-token',
        auth_user: JSON.stringify({ id: 7, role: 'admin' }),
        token_expires_at: '9999999999999',
      },
    }),
    enableCustomUserAgent: false,
    customUserAgent: '',
    viewportWidth: 999,
    viewportHeight: 999,
    deviceScaleFactor: 1,
    waitUntil: 'domcontentloaded',
    waitForSelector: 'body',
    waitAfterLoadedMs: 0,
    navigationTimeoutMs: 1000,
    fullPage: true,
    cropRules: [],
    imageType: 'png',
    imageQuality: 86,
    ...overrides,
  }
}

/**
 * Build the minimum Puppeteer Page surface used by captureStatusScreenshot().
 * The fake page records close/fallback operations and executes evaluateOnNewDocument()
 * against a Map-backed localStorage so the official onboarding key can be asserted.
 */
function makeContext({ hasTour = false, closeFails = false } = {}) {
  const events = []
  const storage = new Map()
  let tourVisible = hasTour

  const page = {
    async setViewport() {},
    async setUserAgent() {},
    async evaluateOnNewDocument(callback, payload) {
      const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
          setItem(key, value) {
            storage.set(String(key), String(value))
          },
        },
      })

      try {
        await callback(payload)
      } finally {
        if (previousDescriptor) {
          Object.defineProperty(globalThis, 'localStorage', previousDescriptor)
        } else {
          delete globalThis.localStorage
        }
      }
    },
    waitForResponse() {
      return Promise.resolve({ status: () => 200 })
    },
    async goto() {},
    async waitForSelector() {},
    async evaluate(callback) {
      const source = String(callback)
      if (source.includes('Boolean(document.querySelector')) return tourVisible

      // This is the disposable-page fallback after driver.js close and Escape both fail.
      if (source.includes('querySelectorAll')) {
        events.push('fallback-cleanup')
        tourVisible = false
        return undefined
      }

      // The remaining evaluation reads location.pathname after the page is ready.
      return '/monitor'
    },
    async $(selector) {
      if (selector !== '.driver-popover-close-btn' || !tourVisible) return null
      return {
        async click() {
          events.push('close-click')
          if (closeFails) throw new Error('simulated close failure')
          tourVisible = false
        },
        async dispose() {},
      }
    },
    keyboard: {
      async press(key) {
        events.push(`key:${key}`)
      },
    },
    async waitForFunction() {
      if (tourVisible) throw new Error('simulated overlay timeout')
      return { async dispose() {} }
    },
    async screenshot() {
      return Buffer.from('test-image')
    },
    async close() {},
  }

  return {
    ctx: {
      puppeteer: {
        async page() {
          return page
        },
      },
    },
    events,
    storage,
  }
}

async function main() {
  const { captureStatusScreenshot } = await loadScreenshotModule()
  assert.equal(typeof captureStatusScreenshot, 'function')

  // 1. Before Vue starts, inject the exact key used by sub2api's v4 admin tour.
  const preempted = makeContext()
  await captureStatusScreenshot(preempted.ctx, makeConfig())
  assert.equal(
    preempted.storage.get('admin_guide_7_admin_v4_interactive'),
    'true',
  )

  // 2. If a future tour still appears, prefer its official close button.
  const officialClose = makeContext({ hasTour: true })
  await captureStatusScreenshot(officialClose.ctx, makeConfig())
  assert.deepEqual(officialClose.events, ['close-click'])

  // 3. If the official close path fails, try Escape and finally clean the disposable page.
  const fallback = makeContext({ hasTour: true, closeFails: true })
  await captureStatusScreenshot(fallback.ctx, makeConfig())
  assert.deepEqual(fallback.events, [
    'close-click',
    'key:Escape',
    'fallback-cleanup',
  ])

  console.log('onboarding-tour: all checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
