import type { Context } from 'koishi'
import {} from 'koishi-plugin-puppeteer'
import type { Page } from 'puppeteer-core'

import { readAuthState } from './auth'
import type { Config } from './config'
import { CROP_DIRECTIONS } from './types'
import type { AuthState, AuthStorage } from './types'
import { sleep } from './utils'

const TREND_VIEWPORT_WIDTH = 2240
const TREND_VIEWPORT_HEIGHT = 1200
const TREND_DEVICE_SCALE_FACTOR = 1
const USERS_TREND_PATH = '/admin/dashboard/users-trend'
const ONBOARDING_STORAGE_VERSION = 'v4_interactive'

function toImageBuffer(rawImage: unknown): Buffer {
  if (typeof rawImage === 'string') return Buffer.from(rawImage, 'base64')
  if (Buffer.isBuffer(rawImage)) return rawImage
  return Buffer.from(rawImage as Uint8Array)
}

function getSub2apiPageUrl(baseUrl: string, pathname: string): string {
  const url = new URL(baseUrl.trim())
  url.pathname = pathname
  url.search = ''
  url.hash = ''
  return url.toString()
}

function parseOrigin(value: string, fieldName: string): string {
  try {
    return new URL(value.trim()).origin
  } catch {
    throw new Error(`🌐 ${fieldName} 不是有效 URL：${value}`)
  }
}

function validateAuthOrigin(authState: AuthState, baseUrl: string): void {
  const authOrigin = parseOrigin(authState.origin, 'authStateJson.origin')
  const configuredOrigin = parseOrigin(baseUrl, 'sub2apiBaseUrl')
  if (authOrigin !== configuredOrigin) {
    throw new Error(`🛡️ 登录态 Origin 与 sub2apiBaseUrl 不一致：${authOrigin} ≠ ${configuredOrigin}。已阻止请求，请使用相同地址重新导出登录态。`)
  }
}

function resolveUserAgent(config: Config, authState: AuthState): string {
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
  if (/[\r\n]/.test(userAgent)) {
    throw new Error(`🏷️ ${sourceName} 不能包含换行符。`)
  }
  return userAgent
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
  await page.evaluateOnNewDocument(({
    entries,
    forceDarkTheme,
    onboardingStorageVersion,
  }) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value !== undefined && value !== null) {
        localStorage.setItem(key, String(value))
      }
    }

    try {
      const authUser = JSON.parse(entries.auth_user)
      const userId = String(authUser?.id ?? '').trim()
      const role = authUser?.role === 'admin' ? 'admin' : 'user'
      if (userId) {
        localStorage.setItem(
          `${role}_guide_${userId}_${role}_${onboardingStorageVersion}`,
          'true',
        )
      }
    } catch {
      // Invalid auth_user is handled by the application auth flow.
    }

    if (!forceDarkTheme) return
    const root = document.documentElement
    root.classList.add('dark')
    new MutationObserver(() => root.classList.add('dark')).observe(root, {
      attributes: true,
      attributeFilter: ['class'],
    })
  }, {
    entries: authStorage,
    forceDarkTheme,
    onboardingStorageVersion: ONBOARDING_STORAGE_VERSION,
  })
}

async function dismissOnboardingTour(page: Page): Promise<void> {
  const hasTour = await page.evaluate(() => {
    return Boolean(document.querySelector('.driver-popover, .driver-overlay'))
  })
  if (!hasTour) return

  let closeTriggered = false
  const closeButton = await page.$('.driver-popover-close-btn')
  if (closeButton) {
    try {
      await closeButton.click()
      closeTriggered = true
    } catch {
      // Fall back to the tour's Escape handler below.
    } finally {
      await closeButton.dispose().catch(() => undefined)
    }
  }
  if (!closeTriggered) {
    await page.keyboard.press('Escape').catch(() => undefined)
  }

  const dismissed = await page.waitForFunction(() => {
    return !document.querySelector('.driver-popover, .driver-overlay')
  }, { timeout: 2000 }).then(async (handle) => {
    await handle.dispose()
    return true
  }).catch(() => false)
  if (dismissed) return

  // The page is disposable; remove stale driver.js artifacts if its own close path failed.
  await page.evaluate(() => {
    document.querySelectorAll('.driver-popover, .driver-overlay').forEach(node => node.remove())
    document.documentElement.classList.remove('driver-active')
    document.body?.classList.remove('driver-active')
    document
      .querySelectorAll('.driver-active-element, .driver-no-interaction')
      .forEach((element) => {
        element.classList.remove('driver-active-element', 'driver-no-interaction')
      })
  })
}

async function prepareAuthenticatedPage(
  page: Page,
  config: Config,
  forceDarkTheme = false,
): Promise<void> {
  const authState = await readAuthState(config)
  validateAuthOrigin(authState, config.sub2apiBaseUrl)
  await page.setUserAgent(resolveUserAgent(config, authState))
  await injectAuthStorage(page, authState.storage, forceDarkTheme)
}

export async function captureStatusScreenshot(ctx: Context, config: Config): Promise<Buffer> {
  const page = await ctx.puppeteer.page()

  try {
    const statusPageUrl = getSub2apiPageUrl(config.sub2apiBaseUrl, '/monitor')
    await page.setViewport({
      width: config.viewportWidth,
      height: config.viewportHeight,
      deviceScaleFactor: config.deviceScaleFactor,
    })
    await prepareAuthenticatedPage(page, config)

    const channelMonitorResponse = page.waitForResponse((response) => {
      const url = response.url()
      return response.request().method() === 'GET'
        && url.includes('/channel-monitors')
        && !url.includes('/admin/')
    }, { timeout: config.navigationTimeoutMs }).catch(() => null)

    await page.goto(statusPageUrl, {
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
    await dismissOnboardingTour(page)

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
    const dashboardUrl = getSub2apiPageUrl(config.sub2apiBaseUrl, '/admin/dashboard')
    await page.setViewport({
      width: TREND_VIEWPORT_WIDTH,
      height: TREND_VIEWPORT_HEIGHT,
      deviceScaleFactor: TREND_DEVICE_SCALE_FACTOR,
    })
    await prepareAuthenticatedPage(page, config, true)

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
    await dismissOnboardingTour(page)

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
