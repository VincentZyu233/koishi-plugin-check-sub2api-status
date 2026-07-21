import type { Config } from './config'
import type { AuthState, AuthStateExport, AuthStorage } from './types'

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

export async function readAuthState(config: Config): Promise<AuthState> {
  const fromConfig = parseAuthStateJson(config.authStateJson)
  if (!fromConfig) {
    throw new Error('🔐 未配置 sub2api 登录态。请先用 tools/export-auth-state.py 或 .mjs 导出，并把控制台输出的 JSON 粘贴到 authStateJson。')
  }
  if (!fromConfig.origin) {
    throw new Error('🌐 authStateJson 缺少 origin。请用最新的登录态导出脚本重新导出。')
  }

  return fromConfig
}
