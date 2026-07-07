import type { ImageType } from './types'

export async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise(resolve => setTimeout(resolve, ms))
}

export function mimeTypeOf(type: ImageType): string {
  if (type === 'jpeg') return 'image/jpeg'
  if (type === 'webp') return 'image/webp'
  return 'image/png'
}
