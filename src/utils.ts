import type { ImageType } from './types'

export type TrendGranularity = 'hour' | 'day'

export interface TrendTimeRange {
  num: number
  granularity: TrendGranularity
  startDate: string
  endDate: string
}

const DEFAULT_TREND_RANGE_NUM = 24
const DEFAULT_TREND_RANGE_UNIT = 'hour'
const MAX_TREND_HOURS = 168
const MAX_TREND_DAYS = 365

const TREND_UNIT_ALIASES: Readonly<Record<string, TrendGranularity>> = {
  h: 'hour',
  hr: 'hour',
  hour: 'hour',
  hours: 'hour',
  时: 'hour',
  小时: 'hour',
  d: 'day',
  day: 'day',
  days: 'day',
  天: 'day',
  日: 'day',
}

export const TREND_UNIT_HELP = 'h/hr/hour/hours/时/小时/d/day/days/天/日'

export async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise(resolve => setTimeout(resolve, ms))
}

export function mimeTypeOf(type: ImageType): string {
  if (type === 'jpeg') return 'image/jpeg'
  if (type === 'webp') return 'image/webp'
  return 'image/png'
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function resolveTrendTimeRange(
  num: number | undefined,
  unit: string | undefined,
  now = new Date(),
): TrendTimeRange {
  const actualNum = num === undefined ? DEFAULT_TREND_RANGE_NUM : Number(num)
  const actualUnit = (unit ?? DEFAULT_TREND_RANGE_UNIT).trim().toLowerCase()
  const granularity = TREND_UNIT_ALIASES[actualUnit]

  if (!granularity) {
    throw new Error(`⏱️ 不支持的时间单位：${unit ?? ''}。支持：${TREND_UNIT_HELP}。`)
  }
  if (!Number.isSafeInteger(actualNum) || actualNum <= 0) {
    throw new Error('🔢 时间数量必须是正整数。')
  }

  const maximum = granularity === 'hour' ? MAX_TREND_HOURS : MAX_TREND_DAYS
  if (actualNum > maximum) {
    const label = granularity === 'hour' ? '小时' : '天'
    throw new Error(`📏 ${label}范围不能超过 ${maximum}。`)
  }

  const end = new Date(now.getTime())
  const start = new Date(now.getTime())
  if (granularity === 'hour') {
    start.setTime(start.getTime() - actualNum * 60 * 60 * 1000)
  } else {
    // The backend includes end_date, so N days starts at today - (N - 1).
    start.setDate(start.getDate() - (actualNum - 1))
  }

  return {
    num: actualNum,
    granularity,
    startDate: formatLocalDate(start),
    endDate: formatLocalDate(end),
  }
}
