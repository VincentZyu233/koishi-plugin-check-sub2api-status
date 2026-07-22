import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

import { formatError, logError, logSuccess } from '../shared/console-style.mjs'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(TEST_DIR, '..', '..')
const AUTH_SOURCE = path.join(PLUGIN_ROOT, 'src', 'auth.ts')
const CONFIG_SOURCE = path.join(PLUGIN_ROOT, 'src', 'config.ts')

async function loadAuthModule() {
  const result = await build({
    absWorkingDir: PLUGIN_ROOT,
    entryPoints: [AUTH_SOURCE],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
    external: ['puppeteer-core'],
  })
  assert.equal(result.outputFiles.length, 1)

  const filename = path.join(TEST_DIR, '.auth-auto-relogin.bundle.cjs')
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

function apiSuccess(data) {
  return {
    status: 200,
    payload: { code: 0, message: 'success', data },
    networkError: '',
  }
}

function apiFailure(status, reason, message = 'request failed') {
  return {
    status,
    payload: { code: status, message, reason },
    networkError: '',
  }
}

function tokenPair(prefix, user) {
  return {
    access_token: `${prefix}-access`,
    refresh_token: `${prefix}-refresh`,
    expires_in: 3600,
    ...(user ? { user } : {}),
  }
}

function makeConfig(overrides = {}) {
  const expiresAt = overrides.expiresAt ?? Date.now() - 1000
  return {
    sub2apiBaseUrl: 'https://sub2api.example.test',
    authStateJson: JSON.stringify({
      origin: 'https://sub2api.example.test',
      userAgent: 'Exported-UA/1.0',
      localStorage: {
        auth_token: 'old-access',
        refresh_token: 'old-refresh',
        auth_user: JSON.stringify({ id: 1, role: 'admin' }),
        token_expires_at: String(expiresAt),
      },
    }),
    enableCustomUserAgent: false,
    customUserAgent: '',
    enableAutoRelogin: false,
    loginEmail: '',
    loginPassword: '',
    navigationTimeoutMs: 45000,
    ...overrides,
  }
}

function makePage(responses = [], initialStorage = {}) {
  const requests = []
  const gotoCalls = []
  const storage = { ...initialStorage }
  let currentUrl = 'about:blank'
  let userAgent = ''

  return {
    page: {
      async setUserAgent(value) {
        userAgent = value
      },
      async goto(url) {
        currentUrl = url
        gotoCalls.push(url)
      },
      url() {
        return currentUrl
      },
      async evaluate(_callback, payload) {
        if (payload && typeof payload === 'object' && 'endpoint' in payload) {
          requests.push(payload)
          const next = responses.shift()
          if (!next) throw new Error(`unexpected auth request: ${payload.endpoint}`)
          return typeof next === 'function' ? next(payload) : next
        }
        if (Array.isArray(payload)) {
          return Object.fromEntries(payload.map(key => [key, storage[key] ?? null]))
        }
        throw new Error('unexpected page.evaluate call')
      },
    },
    requests,
    gotoCalls,
    storage,
    get userAgent() {
      return userAgent
    },
    setUrl(value) {
      currentUrl = value
    },
  }
}

async function assertSchemaFields() {
  const source = await readFile(CONFIG_SOURCE, 'utf8')
  assert.match(
    source,
    /enableAutoRelogin:[\s\S]*?\.default\(false\)/u,
    'automatic relogin must remain opt-in',
  )
  assert.match(
    source,
    /loginPassword:[\s\S]*?\.role\('secret'\)/u,
    'password must use the Koishi secret input role',
  )
}

async function main() {
  const {
    markRuntimeAuthStateStale,
    prepareRuntimeAuthState,
    syncRuntimeAuthStateFromPage,
  } = await loadAuthModule()

  assert.equal(typeof prepareRuntimeAuthState, 'function')
  assert.equal(typeof syncRuntimeAuthStateFromPage, 'function')
  assert.equal(typeof markRuntimeAuthStateStale, 'function')

  // 1. A successful refresh rotates both tokens and does not send credentials.
  const refreshConfig = makeConfig()
  const refreshPage = makePage([apiSuccess(tokenPair('rotated'))])
  const refreshed = await prepareRuntimeAuthState(refreshPage.page, refreshConfig)
  assert.equal(refreshed.storage.auth_token, 'rotated-access')
  assert.equal(refreshed.storage.refresh_token, 'rotated-refresh')
  assert.equal(refreshPage.requests.length, 1)
  assert.match(refreshPage.requests[0].endpoint, /\/auth\/refresh$/u)
  assert.deepEqual(refreshPage.requests[0].body, { refresh_token: 'old-refresh' })
  assert.equal(refreshPage.userAgent, 'Exported-UA/1.0')

  // 2. Password fallback is disabled by default after a terminal refresh failure.
  const disabledConfig = makeConfig()
  const disabledPage = makePage([
    apiFailure(401, 'REFRESH_TOKEN_INVALID'),
  ])
  await assert.rejects(
    prepareRuntimeAuthState(disabledPage.page, disabledConfig),
    /可以配置账号密码后启用自动刷新与重新登录/u,
  )
  assert.equal(disabledPage.requests.length, 1)

  // 3. An enabled fallback logs in through the official API after refresh returns 401.
  const reloginConfig = makeConfig({
    enableAutoRelogin: true,
    loginEmail: 'admin@example.test',
    loginPassword: 'correct-password',
  })
  const reloginPage = makePage([
    apiFailure(401, 'REFRESH_TOKEN_INVALID'),
    apiSuccess(tokenPair('login', { id: 1, role: 'admin', status: 'active' })),
  ])
  const relogged = await prepareRuntimeAuthState(reloginPage.page, reloginConfig)
  assert.equal(relogged.storage.auth_token, 'login-access')
  assert.equal(relogged.storage.refresh_token, 'login-refresh')
  assert.equal(JSON.parse(relogged.storage.auth_user).role, 'admin')
  assert.match(reloginPage.requests[1].endpoint, /\/auth\/login$/u)
  assert.deepEqual(reloginPage.requests[1].body, {
    email: 'admin@example.test',
    password: 'correct-password',
    turnstile_token: '',
  })

  // 4. A TOTP challenge is rejected instead of weakening or bypassing 2FA.
  const totpConfig = makeConfig({
    enableAutoRelogin: true,
    loginEmail: 'admin@example.test',
    loginPassword: 'correct-password',
  })
  const totpPage = makePage([
    apiFailure(401, 'REFRESH_TOKEN_EXPIRED'),
    apiSuccess({ requires_2fa: true, temp_token: 'temporary' }),
  ])
  await assert.rejects(
    prepareRuntimeAuthState(totpPage.page, totpConfig),
    /启用了 TOTP 2FA/u,
  )

  // 5. Concurrent screenshots share one refresh operation for the same config object.
  const concurrentConfig = makeConfig({ enableAutoRelogin: true })
  const delayedRefresh = async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    return apiSuccess(tokenPair('singleflight'))
  }
  const concurrentPageA = makePage([delayedRefresh])
  const concurrentPageB = makePage([])
  const [stateA, stateB] = await Promise.all([
    prepareRuntimeAuthState(concurrentPageA.page, concurrentConfig),
    prepareRuntimeAuthState(concurrentPageB.page, concurrentConfig),
  ])
  assert.equal(stateA.storage.refresh_token, 'singleflight-refresh')
  assert.equal(stateB.storage.refresh_token, 'singleflight-refresh')
  assert.equal(concurrentPageA.requests.length + concurrentPageB.requests.length, 1)

  // 6. Tokens rotated by the sub2api frontend are recovered before the page closes.
  const syncConfig = makeConfig({ expiresAt: Date.now() + 60 * 60 * 1000 })
  const initialPage = makePage([])
  await prepareRuntimeAuthState(initialPage.page, syncConfig)
  const pageExpiry = Date.now() + 2 * 60 * 60 * 1000
  const renderedPage = makePage([], {
    auth_token: 'page-access',
    refresh_token: 'page-refresh',
    auth_user: JSON.stringify({ id: 1, role: 'admin' }),
    token_expires_at: String(pageExpiry),
  })
  renderedPage.setUrl('https://sub2api.example.test/admin/dashboard')
  await syncRuntimeAuthStateFromPage(renderedPage.page, syncConfig)
  markRuntimeAuthStateStale(syncConfig)
  const verifyPage = makePage([apiSuccess(tokenPair('after-sync'))])
  await prepareRuntimeAuthState(verifyPage.page, syncConfig)
  assert.deepEqual(verifyPage.requests[0].body, { refresh_token: 'page-refresh' })

  // 7. Origin mismatch remains fail-closed before any sub2api navigation.
  const wrongOriginConfig = makeConfig({
    authStateJson: JSON.stringify({
      origin: 'https://wrong.example.test',
      userAgent: 'Exported-UA/1.0',
      localStorage: {
        auth_token: 'token',
        refresh_token: 'refresh',
        auth_user: '{}',
        token_expires_at: String(Date.now() - 1),
      },
    }),
  })
  const wrongOriginPage = makePage([])
  await assert.rejects(
    prepareRuntimeAuthState(wrongOriginPage.page, wrongOriginConfig),
    /Origin 与 sub2apiBaseUrl 不一致/u,
  )
  assert.equal(wrongOriginPage.gotoCalls.length, 0)

  await assertSchemaFields()
  logSuccess('auth-auto-relogin：全部检查通过')
}

main().catch((error) => {
  logError('auth-auto-relogin：检查失败', formatError(error))
  process.exitCode = 1
})
