export const LOCAL_STORAGE_KEYS = [
  'auth_token',
  'refresh_token',
  'auth_user',
  'token_expires_at',
] as const

export type LocalStorageKey = typeof LOCAL_STORAGE_KEYS[number]
export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'
export type ImageType = 'png' | 'jpeg' | 'webp'

export const CROP_DIRECTIONS = {
  TOP: 'top',
  RIGHT: 'right',
  BOTTOM: 'bottom',
  LEFT: 'left',
} as const

export type CropDirection = typeof CROP_DIRECTIONS[keyof typeof CROP_DIRECTIONS]

export interface CropRule {
  direction: CropDirection
  pixels: number
  enabled: boolean
}

export interface AuthStateExport {
  origin?: string
  userAgent?: unknown
  exported_at?: string
  localStorage?: Partial<Record<LocalStorageKey, unknown>>
  items?: Partial<Record<LocalStorageKey, unknown>>
  storage?: Partial<Record<LocalStorageKey, unknown>>
  auth_token?: unknown
  refresh_token?: unknown
  auth_user?: unknown
  token_expires_at?: unknown
}

export type AuthStorage = Record<LocalStorageKey, string>

export interface AuthState {
  origin: string
  userAgent: string
  storage: AuthStorage
}
