import type { Page } from 'puppeteer-core'

import type { Config } from './config'
import type { DiagnosticSink } from './diagnostics'
import { LOCAL_STORAGE_KEYS } from './types'
import type { AuthState, AuthStateExport, AuthStorage } from './types'

const AUTH_REFRESH_BUFFER_MS = 2 * 60 * 1000
const AUTO_RELOGIN_COOLDOWN_MS = 60 * 1000
const AUTH_BOOTSTRAP_PATH = '/api/v1/settings/public'
const AUTH_REFRESH_PATH = '/api/v1/auth/refresh'
const AUTH_LOGIN_PATH = '/api/v1/auth/login'

interface RuntimeAuthSession {
  signature: string
  state: AuthState
  lock: Promise<void>
  forceRefresh: boolean
  lastReloginFailureAt: number
}

interface AuthApiResult<T> {
  status: number
  ok: boolean
  data?: T
  message: string
  reason: string
  timedOut: boolean
}

interface TokenPairResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  requires_2fa?: unknown
  user?: unknown
}

const runtimeAuthSessions = new WeakMap<Config, RuntimeAuthSession>()

function normalizeAuthUser(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value
  if (value && typeof value === 'object') return JSON.stringify(value)

  // Vue router only needs a persisted user object to pass the initial guard.
  // The real user will be refreshed from /auth/me after the token is accepted.
  return JSON.stringify({
    id: 0,
    email: 'bot@local',
    username: 'bot',
    role: 'user',
    status: 'active',
  })
}

function normalizeAuthState(raw: AuthStateExport): AuthState | null {
  const source = raw.localStorage ?? raw.items ?? raw.storage ?? raw
  const authToken = source.auth_token
  const refreshToken = source.refresh_token
  if (!authToken && !refreshToken) return null

  const now = Date.now()
  const storage: AuthStorage = {
    auth_token: String(authToken || 'refresh-required'),
    refresh_token: refreshToken ? String(refreshToken) : '',
    auth_user: normalizeAuthUser(source.auth_user),
    token_expires_at: source.token_expires_at
      ? String(source.token_expires_at)
      : String(now + 24 * 60 * 60 * 1000),
  }

  return {
    origin: typeof raw.origin === 'string' ? raw.origin.trim() : '',
    userAgent: typeof raw.userAgent === 'string' ? raw.userAgent.trim() : '',
    storage,
  }
}

function parseAuthStateJson(content: string): AuthState | null {
  const trimmed = content.trim()
  if (!trimmed) return null
  return normalizeAuthState(JSON.parse(trimmed))
}

function cloneAuthState(state: AuthState): AuthState {
  return {
    origin: state.origin,
    userAgent: state.userAgent,
    storage: { ...state.storage },
  }
}

function parseOrigin(value: string, fieldName: string): string {
  try {
    return new URL(value.trim()).origin
  } catch {
    throw new Error(`🌐 ${fieldName} 不是有效 URL：${value}`)
  }
}

export function validateAuthOrigin(authState: AuthState, baseUrl: string): void {
  const authOrigin = parseOrigin(authState.origin, 'authStateJson.origin')
  const configuredOrigin = parseOrigin(baseUrl, 'sub2apiBaseUrl')
  if (authOrigin !== configuredOrigin) {
    throw new Error(`🛡️ 登录态 Origin 与 sub2apiBaseUrl 不一致：${authOrigin} ≠ ${configuredOrigin}。已阻止请求，请使用相同地址重新导出登录态。`)
  }
}

export function resolveUserAgent(config: Config, authState: AuthState): string {
  const sourceName = config.enableCustomUserAgent
    ? 'customUserAgent'
    : 'authStateJson.userAgent'
  const candidate = config.enableCustomUserAgent
    ? config.customUserAgent
    : authState.userAgent
  const userAgent = typeof candidate === 'string' ? candidate.trim() : ''

  if (!userAgent) {
    if (config.enableCustomUserAgent) {
      throw new Error('🏷️ 已启用自定义 User-Agent，但 customUserAgent 为空。')
    }
    throw new Error('🏷️ authStateJson 缺少 userAgent。请用最新脚本重新导出，或启用自定义 User-Agent。')
  }
  if (/[\r\n]/u.test(userAgent)) {
    throw new Error(`🏷️ ${sourceName} 不能包含换行符。`)
  }
  return userAgent
}

function authConfigSignature(config: Config): string {
  return JSON.stringify([
    config.authStateJson,
    config.sub2apiBaseUrl,
    config.enableCustomUserAgent,
    config.customUserAgent,
    config.enableAutoRelogin,
    config.loginEmail,
    config.loginPassword,
  ])
}

function getRuntimeAuthSession(config: Config): RuntimeAuthSession {
  const signature = authConfigSignature(config)
  const existing = runtimeAuthSessions.get(config)
  if (existing?.signature === signature) return existing

  const state = readConfiguredAuthState(config)
  validateAuthOrigin(state, config.sub2apiBaseUrl)
  const session: RuntimeAuthSession = {
    signature,
    state,
    lock: Promise.resolve(),
    // Auto relogin validates and rotates the exported refresh token once per process.
    forceRefresh: Boolean(config.enableAutoRelogin),
    lastReloginFailureAt: 0,
  }
  runtimeAuthSessions.set(config, session)
  return session
}

async function withAuthLock<T>(
  session: RuntimeAuthSession,
  task: () => Promise<T>,
): Promise<T> {
  const previous = session.lock
  let release!: () => void
  session.lock = new Promise<void>(resolve => {
    release = resolve
  })

  await previous
  try {
    return await task()
  } finally {
    release()
  }
}

interface TokenRefreshDecision {
  required: boolean
  reason: string
  remainingMs?: number
}

function getTokenRefreshDecision(session: RuntimeAuthSession): TokenRefreshDecision {
  if (session.forceRefresh) return { required: true, reason: 'forced' }
  if (!session.state.storage.auth_token || session.state.storage.auth_token === 'refresh-required') {
    return { required: true, reason: 'missing-access-token' }
  }
  const expiresAt = Number(session.state.storage.token_expires_at)
  if (!Number.isFinite(expiresAt)) return { required: true, reason: 'invalid-expiry' }
  const remainingMs = expiresAt - Date.now()
  if (remainingMs <= AUTH_REFRESH_BUFFER_MS) {
    return {
      required: true,
      reason: remainingMs <= 0 ? 'expired' : 'expires-soon',
      remainingMs,
    }
  }
  return { required: false, reason: 'valid', remainingMs }
}

function apiUrl(baseUrl: string, pathname: string): string {
  const url = new URL(baseUrl.trim())
  url.pathname = pathname
  url.search = ''
  url.hash = ''
  return url.toString()
}

function readConfiguredAuthState(config: Config): AuthState {
  const fromConfig = parseAuthStateJson(config.authStateJson)
  if (!fromConfig) {
    throw new Error('🔐 未配置 sub2api 登录态。请先用 tools/export-auth-state.py 或 .mjs 导出，并把控制台输出的 JSON 粘贴到 authStateJson。')
  }
  if (!fromConfig.origin) {
    throw new Error('🌐 authStateJson 缺少 origin。请用最新的登录态导出脚本重新导出。')
  }

  return fromConfig
}

export async function readAuthState(config: Config): Promise<AuthState> {
  return readConfiguredAuthState(config)
}

async function openAuthOrigin(
  page: Page,
  config: Config,
  diagnostics?: DiagnosticSink,
): Promise<void> {
  const startedAt = Date.now()
  diagnostics?.event('auth.bootstrap.start', '打开认证同源引导地址')
  await page.goto(apiUrl(config.sub2apiBaseUrl, AUTH_BOOTSTRAP_PATH), {
    waitUntil: 'domcontentloaded',
    timeout: config.navigationTimeoutMs,
  })
  diagnostics?.event('auth.bootstrap.ok', '认证同源引导地址加载完成', {
    durationMs: Date.now() - startedAt,
  })
}

async function requestAuthApi<T>(
  page: Page,
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<AuthApiResult<T>> {
  const result = await page.evaluate(async ({ endpoint, body, timeoutMs }) => {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      return {
        status: response.status,
        payload,
        networkError: '',
        timedOut: false,
      }
    } catch (error) {
      return {
        status: 0,
        payload: null,
        networkError: error instanceof Error ? error.message : String(error),
        timedOut: controller.signal.aborted,
      }
    } finally {
      clearTimeout(timeoutId)
    }
  }, { endpoint, body, timeoutMs })

  const envelope = result.payload && typeof result.payload === 'object'
    ? result.payload as Record<string, unknown>
    : {}
  const code = typeof envelope.code === 'number' ? envelope.code : undefined
  const message = typeof envelope.message === 'string' ? envelope.message : ''
  const reason = typeof envelope.reason === 'string' ? envelope.reason : ''
  const data = ('data' in envelope ? envelope.data : result.payload) as T | undefined
  const ok = result.status >= 200
    && result.status < 300
    && (code === undefined || code === 0)

  return {
    status: result.status,
    ok,
    data,
    message: result.timedOut
      ? `请求超过 ${timeoutMs}ms 未完成`
      : result.networkError || message,
    reason,
    timedOut: result.timedOut,
  }
}

function updateTokenPair(
  session: RuntimeAuthSession,
  payload: TokenPairResponse,
  user?: unknown,
): AuthState {
  const accessToken = typeof payload.access_token === 'string'
    ? payload.access_token.trim()
    : ''
  const refreshToken = typeof payload.refresh_token === 'string'
    ? payload.refresh_token.trim()
    : ''
  const expiresIn = Number(payload.expires_in)
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('🔐 sub2api 认证响应缺少完整的 access_token、refresh_token 或 expires_in。')
  }

  session.state = {
    ...session.state,
    storage: {
      auth_token: accessToken,
      refresh_token: refreshToken,
      auth_user: user === undefined
        ? session.state.storage.auth_user
        : normalizeAuthUser(user),
      token_expires_at: String(Date.now() + expiresIn * 1000),
    },
  }
  session.forceRefresh = false
  return cloneAuthState(session.state)
}

function authApiError(action: string, result: AuthApiResult<unknown>): Error {
  const detail = result.reason || result.message || `HTTP ${result.status || 0}`
  return new Error(`🔐 sub2api ${action}失败：${detail}。`)
}

function isTerminalRefreshFailure(result: AuthApiResult<unknown>): boolean {
  return result.status === 401
    || result.status === 403
    || [
      'REFRESH_TOKEN_INVALID',
      'REFRESH_TOKEN_EXPIRED',
      'REFRESH_TOKEN_REUSED',
      'SESSION_BINDING_MISMATCH',
      'TOKEN_REVOKED',
    ].includes(result.reason)
}

async function refreshRuntimeAuthState(
  page: Page,
  config: Config,
  session: RuntimeAuthSession,
  diagnostics?: DiagnosticSink,
): Promise<AuthState | null> {
  const refreshToken = session.state.storage.refresh_token.trim()
  if (!refreshToken) {
    diagnostics?.event('auth.refresh.skip', '没有可用的 refresh token')
    return null
  }

  const startedAt = Date.now()
  diagnostics?.event('auth.refresh.start', '开始刷新登录态')
  const result = await requestAuthApi<TokenPairResponse>(
    page,
    apiUrl(config.sub2apiBaseUrl, AUTH_REFRESH_PATH),
    { refresh_token: refreshToken },
    config.navigationTimeoutMs,
  )
  diagnostics?.event(
    result.ok ? 'auth.refresh.ok' : 'auth.refresh.failed',
    result.ok ? '登录态刷新成功' : '登录态刷新失败',
    {
      status: result.status,
      reason: result.reason || undefined,
      timedOut: result.timedOut,
      durationMs: Date.now() - startedAt,
    },
  )
  if (result.ok && result.data) {
    const state = updateTokenPair(session, result.data)
    diagnostics?.event('auth.session.updated', '运行时 token 对已经轮换', {
      expiresAt: state.storage.token_expires_at,
    })
    return state
  }
  if (isTerminalRefreshFailure(result)) {
    diagnostics?.event('auth.refresh.terminal', 'refresh token 已确定失效，准备判断密码回退', {
      status: result.status,
      reason: result.reason || undefined,
    })
    return null
  }
  throw authApiError('刷新登录态', result)
}

async function reloginRuntimeAuthState(
  page: Page,
  config: Config,
  session: RuntimeAuthSession,
  diagnostics?: DiagnosticSink,
): Promise<AuthState> {
  if (!config.enableAutoRelogin) {
    diagnostics?.event('auth.relogin.disabled', '密码重新登录未启用')
    throw new Error('🔐 sub2api 登录态已经失效，请重新导出登录态；也可以配置账号密码后启用自动刷新与重新登录。')
  }

  const email = typeof config.loginEmail === 'string' ? config.loginEmail.trim() : ''
  const password = typeof config.loginPassword === 'string' ? config.loginPassword : ''
  if (!email || !password) {
    diagnostics?.event('auth.relogin.invalid-config', '密码重新登录配置不完整', {
      emailConfigured: Boolean(email),
      passwordConfigured: Boolean(password),
    })
    throw new Error('🔐 已启用自动刷新与重新登录，但 loginEmail 或 loginPassword 为空。')
  }

  const elapsed = Date.now() - session.lastReloginFailureAt
  if (session.lastReloginFailureAt && elapsed < AUTO_RELOGIN_COOLDOWN_MS) {
    const remainingSeconds = Math.ceil((AUTO_RELOGIN_COOLDOWN_MS - elapsed) / 1000)
    diagnostics?.event('auth.relogin.cooldown', '密码重新登录处于失败冷却期', {
      remainingSeconds,
    })
    throw new Error(`⏳ 自动重新登录处于失败冷却期，请在 ${remainingSeconds} 秒后重试。`)
  }

  const startedAt = Date.now()
  diagnostics?.event('auth.relogin.start', '开始使用已配置凭据重新登录', {
    credentialsConfigured: true,
  })
  const result = await requestAuthApi<TokenPairResponse>(
    page,
    apiUrl(config.sub2apiBaseUrl, AUTH_LOGIN_PATH),
    {
      email,
      password,
      turnstile_token: '',
    },
    config.navigationTimeoutMs,
  )
  diagnostics?.event(
    result.ok ? 'auth.relogin.response' : 'auth.relogin.failed',
    result.ok ? '重新登录接口返回成功' : '重新登录接口返回失败',
    {
      status: result.status,
      reason: result.reason || undefined,
      timedOut: result.timedOut,
      durationMs: Date.now() - startedAt,
    },
  )
  if (result.ok && result.data?.requires_2fa === true) {
    session.lastReloginFailureAt = Date.now()
    diagnostics?.event('auth.relogin.totp', '重新登录需要 TOTP 2FA，已停止自动处理')
    throw new Error('🔐 sub2api 管理员账号启用了 TOTP 2FA，无法执行无人值守自动重新登录。')
  }
  if (!result.ok || !result.data) {
    session.lastReloginFailureAt = Date.now()
    throw authApiError('自动重新登录', result)
  }

  try {
    const state = updateTokenPair(session, result.data, result.data.user)
    session.lastReloginFailureAt = 0
    diagnostics?.event('auth.relogin.ok', '密码重新登录成功并更新运行时 token 对', {
      expiresAt: state.storage.token_expires_at,
    })
    return state
  } catch (error) {
    session.lastReloginFailureAt = Date.now()
    throw error
  }
}

export async function prepareRuntimeAuthState(
  page: Page,
  config: Config,
  diagnostics?: DiagnosticSink,
): Promise<AuthState> {
  const session = getRuntimeAuthSession(config)
  validateAuthOrigin(session.state, config.sub2apiBaseUrl)
  await page.setUserAgent(resolveUserAgent(config, session.state))
  diagnostics?.event('auth.session.ready', '登录态 Origin 与 User-Agent 校验完成', {
    customUserAgent: Boolean(config.enableCustomUserAgent),
    autoRelogin: Boolean(config.enableAutoRelogin),
    refreshTokenConfigured: Boolean(session.state.storage.refresh_token.trim()),
  })

  const lockStartedAt = Date.now()
  return withAuthLock(session, async () => {
    diagnostics?.event('auth.lock.acquired', '已取得认证互斥锁', {
      waitMs: Date.now() - lockStartedAt,
    })
    const decision = getTokenRefreshDecision(session)
    diagnostics?.event('auth.check', '完成 access token 有效期检查', {
      refreshRequired: decision.required,
      reason: decision.reason,
      ...(decision.remainingMs === undefined
        ? {}
        : { remainingSeconds: Math.floor(decision.remainingMs / 1000) }),
    })
    if (!decision.required) return cloneAuthState(session.state)

    await openAuthOrigin(page, config, diagnostics)
    const refreshed = await refreshRuntimeAuthState(page, config, session, diagnostics)
    if (refreshed) return refreshed
    return reloginRuntimeAuthState(page, config, session, diagnostics)
  })
}

export function markRuntimeAuthStateStale(config: Config): void {
  const session = runtimeAuthSessions.get(config)
  if (session) session.forceRefresh = true
}

export async function syncRuntimeAuthStateFromPage(
  page: Page,
  config: Config,
  diagnostics?: DiagnosticSink,
): Promise<void> {
  const session = runtimeAuthSessions.get(config)
  if (!session) {
    diagnostics?.event('auth.sync.skip', '运行时认证会话尚未创建')
    return
  }

  let currentOrigin: string
  try {
    currentOrigin = new URL(page.url()).origin
  } catch {
    diagnostics?.event('auth.sync.skip', '页面 URL 无法解析')
    return
  }
  if (currentOrigin !== parseOrigin(config.sub2apiBaseUrl, 'sub2apiBaseUrl')) {
    diagnostics?.event('auth.sync.skip', '页面 Origin 与配置不一致')
    return
  }

  const storage = await page.evaluate((keys) => {
    return Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)]))
  }, LOCAL_STORAGE_KEYS) as Partial<Record<typeof LOCAL_STORAGE_KEYS[number], string | null>>
  const authToken = storage.auth_token?.trim()
  const refreshToken = storage.refresh_token?.trim()
  const expiresAt = Number(storage.token_expires_at)
  if (!authToken || !refreshToken || !Number.isFinite(expiresAt)) {
    diagnostics?.event('auth.sync.skip', '页面没有完整的可回收 token 对')
    return
  }

  await withAuthLock(session, async () => {
    const currentExpiresAt = Number(session.state.storage.token_expires_at)
    if (Number.isFinite(currentExpiresAt) && expiresAt < currentExpiresAt) {
      diagnostics?.event('auth.sync.skip', '页面 token 对早于当前运行时会话')
      return
    }
    session.state = {
      ...session.state,
      storage: {
        auth_token: authToken,
        refresh_token: refreshToken,
        auth_user: storage.auth_user?.trim() || session.state.storage.auth_user,
        token_expires_at: String(expiresAt),
      },
    }
    session.forceRefresh = false
    diagnostics?.event('auth.sync.ok', '已从页面回收最新运行时 token 对', {
      expiresAt: String(expiresAt),
    })
  })
}
