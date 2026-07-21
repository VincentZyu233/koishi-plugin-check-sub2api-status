import type { Context } from 'koishi'
import {} from 'koishi-plugin-puppeteer'
import type { Page } from 'puppeteer-core'

import { readAuthState } from './auth'
import type { Config } from './config'
import { CROP_DIRECTIONS } from './types'
import type { AuthStorage } from './types'
import { sleep } from './utils'

const TREND_VIEWPORT_WIDTH = 2240
const TREND_VIEWPORT_HEIGHT = 1200
const TREND_DEVICE_SCALE_FACTOR = 1
const USERS_TREND_PATH = '/admin/dashboard/users-trend'

function toImageBuffer(rawImage: unknown): Buffer {
  if (typeof rawImage === 'string') return Buffer.from(rawImage, 'base64')
  if (Buffer.isBuffer(rawImage)) return rawImage
  return Buffer.from(rawImage as Uint8Array)
}

function getDashboardUrl(monitorUrl: string): string {
  const url = new URL(monitorUrl)
  url.pathname = '/admin/dashboard'
  url.search = ''
  url.hash = ''
  return url.toString()
}

function getCropMargins(config: Config) {
  const margins = {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  }
  const usedDirections = new Set<string>()

  for (const rule of config.cropRules ?? []) {
    if (!rule?.enabled) continue
    if (usedDirections.has(rule.direction)) continue

    const pixels = Math.max(0, Number(rule.pixels) || 0)
    // Duplicate directions intentionally use the first enabled table row.
    if (rule.direction === CROP_DIRECTIONS.TOP) margins.top = pixels
    else if (rule.direction === CROP_DIRECTIONS.RIGHT) margins.right = pixels
    else if (rule.direction === CROP_DIRECTIONS.BOTTOM) margins.bottom = pixels
    else if (rule.direction === CROP_DIRECTIONS.LEFT) margins.left = pixels
    else continue

    usedDirections.add(rule.direction)
  }

  return margins
}

async function injectAuthStorage(
  page: Page,
  authStorage: AuthStorage,
  forceDarkTheme = false,
): Promise<void> {
  await page.evaluateOnNewDocument(({ entries, forceDarkTheme }) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value !== undefined && value !== null) {
        localStorage.setItem(key, String(value))
      }
    }

    if (!forceDarkTheme) return
    const root = document.documentElement
    root.classList.add('dark')
    new MutationObserver(() => root.classList.add('dark')).observe(root, {
      attributes: true,
      attributeFilter: ['class'],
    })
  }, { entries: authStorage, forceDarkTheme })
}

export async function captureStatusScreenshot(ctx: Context, config: Config): Promise<Buffer> {
  const page = await ctx.puppeteer.page()

  try {
    const authStorage = await readAuthState(config)
    await page.setViewport({
      width: config.viewportWidth,
      height: config.viewportHeight,
      deviceScaleFactor: config.deviceScaleFactor,
    })
    await injectAuthStorage(page, authStorage)

    const channelMonitorResponse = page.waitForResponse((response) => {
      const url = response.url()
      return response.request().method() === 'GET'
        && url.includes('/channel-monitors')
        && !url.includes('/admin/')
    }, { timeout: config.navigationTimeoutMs }).catch(() => null)

    await page.goto(config.monitorUrl.trim(), {
      waitUntil: config.waitUntil,
      timeout: config.navigationTimeoutMs,
    })
    await page.waitForSelector(config.waitForSelector, {
      timeout: config.navigationTimeoutMs,
    })

    const response = await channelMonitorResponse
    if (response?.status() === 401) {
      throw new Error('🔐 sub2api 返回 401，登录态已失效或 refresh_token 已被轮换。请重新导出登录态。')
    }

    await sleep(config.waitAfterLoadedMs)

    const currentPath = await page.evaluate(() => location.pathname)
    if (currentPath.startsWith('/login')) {
      throw new Error('🚪 页面跳到了 /login，说明 localStorage 登录态没有生效。')
    }

    const {
      top: cropTop,
      right: cropRight,
      bottom: cropBottom,
      left: cropLeft,
    } = getCropMargins(config)
    const hasCrop = cropTop > 0 || cropRight > 0 || cropBottom > 0 || cropLeft > 0

    const screenshotOptions: any = {
      type: config.imageType,
    }
    if (hasCrop) {
      const pageSize = await page.evaluate(() => ({
        width: Math.max(
          document.documentElement.scrollWidth,
          document.body?.scrollWidth || 0,
          window.innerWidth,
        ),
        height: Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight || 0,
          window.innerHeight,
        ),
      }))
      const width = Math.floor(pageSize.width - cropLeft - cropRight)
      const height = Math.floor(pageSize.height - cropTop - cropBottom)
      if (width <= 0 || height <= 0) {
        throw new Error(`✂️ 裁剪尺寸无效：页面 ${pageSize.width}x${pageSize.height}，裁剪 top/right/bottom/left = ${cropTop}/${cropRight}/${cropBottom}/${cropLeft}`)
      }
      screenshotOptions.clip = {
        x: cropLeft,
        y: cropTop,
        width,
        height,
      }
    } else {
      screenshotOptions.fullPage = config.fullPage
    }
    if (config.imageType !== 'png') {
      screenshotOptions.quality = config.imageQuality
    }

    return toImageBuffer(await page.screenshot(screenshotOptions))
  } finally {
    await page.close().catch(() => undefined)
  }
}

export async function captureTrendScreenshot(ctx: Context, config: Config): Promise<Buffer> {
  const page = await ctx.puppeteer.page()

  try {
    const authStorage = await readAuthState(config)
    const dashboardUrl = getDashboardUrl(config.monitorUrl.trim())
    await page.setViewport({
      width: TREND_VIEWPORT_WIDTH,
      height: TREND_VIEWPORT_HEIGHT,
      deviceScaleFactor: TREND_DEVICE_SCALE_FACTOR,
    })
    await injectAuthStorage(page, authStorage, true)

    const usersTrendResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'GET'
        && url.pathname.endsWith(USERS_TREND_PATH)
    }, { timeout: config.navigationTimeoutMs }).then(response => ({
      kind: 'trend' as const,
      response,
    }))
    const authFailureResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'POST'
        && url.pathname.endsWith('/auth/refresh')
        && (response.status() === 401 || response.status() === 403)
    }, { timeout: config.navigationTimeoutMs }).then(response => ({
      kind: 'auth' as const,
      response,
    }))

    await page.goto(dashboardUrl, {
      waitUntil: config.waitUntil,
      timeout: config.navigationTimeoutMs,
    })

    const responseResult = await Promise
      .race([usersTrendResponse, authFailureResponse])
      .catch(() => null)
    if (!responseResult) {
      throw new Error('📈 等待最近使用趋势接口超时。')
    }
    if (responseResult.kind === 'auth') {
      throw new Error('🔐 sub2api 登录态已经失效，请重新导出登录态。')
    }

    const { response } = responseResult
    if (response.status() === 401 || response.status() === 403) {
      throw new Error(`🔐 sub2api 返回 ${response.status()}，当前登录态无权访问管理仪表盘或已经失效。`)
    }
    if (response.status() >= 400) {
      throw new Error(`📡 最近使用趋势接口返回 HTTP ${response.status()}。`)
    }

    await page.waitForFunction(() => {
      const headings = Array.from(document.querySelectorAll('h3'))
      const heading = headings.find((element) => {
        const text = element.textContent?.trim() || ''
        return /Top\s*12/i.test(text) || text.includes('最近使用')
      })
      const card = heading?.closest('.card')
      if (!card) return false

      card.setAttribute('data-sub2api-trend-card', 'true')
      return true
    }, { timeout: config.navigationTimeoutMs })

    await sleep(Math.max(config.waitAfterLoadedMs, 1200))

    const currentPath = await page.evaluate(() => location.pathname)
    if (currentPath.startsWith('/login')) {
      throw new Error('🚪 页面跳到了 /login，说明 localStorage 登录态没有生效。')
    }

    const trendCard = await page.$('[data-sub2api-trend-card="true"]')
    if (!trendCard) {
      throw new Error('🎯 找不到最近使用趋势图表组件。')
    }
    const hasRenderableCanvas = await trendCard.evaluate((element) => {
      const canvas = element.querySelector('canvas')
      return Boolean(canvas && canvas.width > 0 && canvas.height > 0)
    })
    if (!hasRenderableCanvas) {
      throw new Error('📭 最近使用趋势暂无数据。')
    }

    const screenshotOptions: any = {
      type: config.imageType,
    }
    if (config.imageType !== 'png') {
      screenshotOptions.quality = config.imageQuality
    }

    return toImageBuffer(await trendCard.screenshot(screenshotOptions))
  } finally {
    await page.close().catch(() => undefined)
  }
}
