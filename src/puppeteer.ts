import type { Context } from 'koishi'
import {} from 'koishi-plugin-puppeteer'
import type { Page } from 'puppeteer-core'

import {
  markRuntimeAuthStateStale,
  prepareRuntimeAuthState,
  syncRuntimeAuthStateFromPage,
} from './auth'
import type { Config } from './config'
import {
  createCaptureDiagnostics,
  type CaptureDiagnostics,
} from './diagnostics'
import { CROP_DIRECTIONS, TREND_SCREENSHOT_RANGES } from './types'
import type { AuthStorage, TrendScreenshotRange } from './types'
import { resolveTrendTimeRange, sleep } from './utils'
import type { TrendTimeRange } from './utils'

const TREND_VIEWPORT_WIDTH = 2240
const TREND_VIEWPORT_HEIGHT = 1200
const USERS_TREND_PATH = '/admin/dashboard/users-trend'
const DASHBOARD_SNAPSHOT_PATH = '/admin/dashboard/snapshot-v2'
const ONBOARDING_STORAGE_VERSION = 'v4_interactive'
const CANVAS_STABLE_DURATION_MS = 750
const CANVAS_POLL_INTERVAL_MS = 150
const CANVAS_MIN_PAINTED_SAMPLES = 8

export type TrendScreenshotRegion = 'filter' | 'charts' | 'recent'

export interface TrendScreenshotRect {
  x: number
  y: number
  width: number
  height: number
}

const TREND_REGION_SELECTORS: Record<TrendScreenshotRegion, string> = {
  filter: '[data-sub2api-trend-filter="true"]',
  charts: '[data-sub2api-trend-charts="true"]',
  recent: '[data-sub2api-trend-card="true"]',
}

export function resolveTrendScreenshotRegions(
  range: TrendScreenshotRange | undefined,
): TrendScreenshotRegion[] {
  switch (range ?? TREND_SCREENSHOT_RANGES.ALL) {
    case TREND_SCREENSHOT_RANGES.ALL:
      return ['filter', 'charts', 'recent']
    case TREND_SCREENSHOT_RANGES.CHARTS_AND_RECENT:
      return ['charts', 'recent']
    case TREND_SCREENSHOT_RANGES.RECENT_ONLY:
      return ['recent']
    default:
      throw new Error(`📐 不支持的趋势截图范围：${String(range)}`)
  }
}

export function mergeTrendScreenshotRects(
  rects: TrendScreenshotRect[],
): TrendScreenshotRect {
  if (!rects.length || rects.some(rect => (
    !Number.isFinite(rect.x)
    || !Number.isFinite(rect.y)
    || !Number.isFinite(rect.width)
    || !Number.isFinite(rect.height)
    || rect.width <= 0
    || rect.height <= 0
  ))) {
    throw new Error('📐 趋势截图区域尺寸无效。')
  }

  const left = Math.min(...rects.map(rect => rect.x))
  const top = Math.min(...rects.map(rect => rect.y))
  const right = Math.max(...rects.map(rect => rect.x + rect.width))
  const bottom = Math.max(...rects.map(rect => rect.y + rect.height))
  const x = Math.max(0, Math.floor(left))
  const y = Math.max(0, Math.floor(top))

  return {
    x,
    y,
    width: Math.ceil(right) - x,
    height: Math.ceil(bottom) - y,
  }
}

interface CanvasRenderProbe {
  width: number
  height: number
  clientWidth: number
  clientHeight: number
  paintedSamples: number
  hash: number
}

interface CanvasWaitResult {
  stable: boolean
  polls: number
  durationMs: number
  probes: CanvasRenderProbe[] | null
}

async function readCanvasRenderProbes(
  page: Page,
  selector: string,
  minimumCount: number,
): Promise<CanvasRenderProbe[] | null> {
  return page.$eval(selector, (element, requiredCount) => {
    const canvases = Array.from(element.querySelectorAll('canvas'))
    if (canvases.length < requiredCount) return null

    return canvases.map((canvas) => {
      const width = canvas.width
      const height = canvas.height
      const clientWidth = canvas.clientWidth
      const clientHeight = canvas.clientHeight
      if (width <= 0 || height <= 0 || clientWidth <= 0 || clientHeight <= 0) {
        return { width, height, clientWidth, clientHeight, paintedSamples: 0, hash: 0 }
      }

      // Downsample before reading pixels so high deviceScaleFactor values do not
      // force a full multi-megapixel GPU readback on every stability poll.
      const probe = document.createElement('canvas')
      probe.width = 64
      probe.height = 32
      const context = probe.getContext('2d', { willReadFrequently: true })
      if (!context) {
        return { width, height, clientWidth, clientHeight, paintedSamples: 0, hash: 0 }
      }
      context.drawImage(canvas, 0, 0, probe.width, probe.height)
      const pixels = context.getImageData(0, 0, probe.width, probe.height).data
      let paintedSamples = 0
      let hash = 2166136261
      for (let index = 0; index < pixels.length; index += 4) {
        const alpha = pixels[index + 3]
        if (alpha > 0) paintedSamples += 1
        hash ^= pixels[index]
        hash = Math.imul(hash, 16777619)
        hash ^= pixels[index + 1]
        hash = Math.imul(hash, 16777619)
        hash ^= pixels[index + 2]
        hash = Math.imul(hash, 16777619)
        hash ^= alpha
        hash = Math.imul(hash, 16777619)
      }

      return {
        width,
        height,
        clientWidth,
        clientHeight,
        paintedSamples,
        hash: hash >>> 0,
      }
    })
  }, minimumCount).catch(() => null)
}

async function waitForStableCanvases(
  page: Page,
  selector: string,
  minimumCount: number,
  timeoutMs: number,
): Promise<CanvasWaitResult> {
  const startedAt = Date.now()
  await page.evaluate(async () => {
    await document.fonts?.ready
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  }).catch(() => undefined)

  const deadline = Date.now() + timeoutMs
  let previousSignature = ''
  let stableSince = 0
  let polls = 0
  let lastProbes: CanvasRenderProbe[] | null = null

  while (Date.now() < deadline) {
    const probes = await readCanvasRenderProbes(page, selector, minimumCount)
    polls += 1
    lastProbes = probes
    const ready = probes !== null
      && probes.length >= minimumCount
      && probes.every(probe => probe.paintedSamples >= CANVAS_MIN_PAINTED_SAMPLES)

    if (ready) {
      const signature = JSON.stringify(probes)
      if (signature === previousSignature) {
        if (Date.now() - stableSince >= CANVAS_STABLE_DURATION_MS) {
          return {
            stable: true,
            polls,
            durationMs: Date.now() - startedAt,
            probes,
          }
        }
      } else {
        previousSignature = signature
        stableSince = Date.now()
      }
    } else {
      previousSignature = ''
      stableSince = 0
    }

    await sleep(Math.min(CANVAS_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())))
  }

  return {
    stable: false,
    polls,
    durationMs: Date.now() - startedAt,
    probes: lastProbes,
  }
}

async function waitForTrendApiResponses(
  page: Page,
  timeoutMs: number,
  includesCharts: boolean,
  expectedRange: TrendTimeRange | undefined,
  trigger: () => Promise<unknown>,
  diagnostics: CaptureDiagnostics,
  phase: 'initial' | 'range',
): Promise<void> {
  const startedAt = Date.now()
  const authFailureResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === 'POST'
      && url.pathname.endsWith('/auth/refresh')
      && (response.status() === 401 || response.status() === 403)
  }, { timeout: timeoutMs }).then(response => ({
    kind: 'auth' as const,
    response,
  }))
  const requiredResponseSpecs = [
    { name: '最近使用趋势', pathname: USERS_TREND_PATH },
    ...(includesCharts
      ? [{ name: '模型分布与 Token 使用趋势', pathname: DASHBOARD_SNAPSHOT_PATH }]
      : []),
  ]
  const requiredResponseResults = requiredResponseSpecs.map(({ name, pathname }) => {
    const requiredResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      const matchesRange = !expectedRange || (
        url.searchParams.get('start_date') === expectedRange.startDate
        && url.searchParams.get('end_date') === expectedRange.endDate
        && url.searchParams.get('granularity') === expectedRange.granularity
      )
      return response.request().method() === 'GET'
        && url.pathname.endsWith(pathname)
        && matchesRange
    }, { timeout: timeoutMs }).then(response => ({
      kind: 'required' as const,
      name,
      response,
    }))

    return Promise.race([requiredResponse, authFailureResponse])
  })

  diagnostics.event(`api.${phase}.start`, '开始等待趋势接口响应', {
    expected: requiredResponseSpecs.map(spec => spec.pathname),
    ...(expectedRange ? {
      range: {
        num: expectedRange.num,
        granularity: expectedRange.granularity,
        startDate: expectedRange.startDate,
        endDate: expectedRange.endDate,
      },
    } : {}),
  })
  await trigger()

  const responseResults = await Promise
    .all(requiredResponseResults)
    .catch(() => null)
  if (!responseResults) {
    const rangeLabel = expectedRange
      ? `${expectedRange.num} ${expectedRange.granularity}`
      : includesCharts ? '仪表盘趋势' : '最近使用趋势'
    diagnostics.event(`api.${phase}.timeout`, '等待趋势接口响应超时', {
      rangeLabel,
      durationMs: Date.now() - startedAt,
    })
    throw new Error(`📈 等待 ${rangeLabel} 接口响应超时。`)
  }
  if (responseResults.some(result => result.kind === 'auth')) {
    diagnostics.event(`api.${phase}.auth-failed`, '页面 refresh 接口返回认证错误', {
      durationMs: Date.now() - startedAt,
    })
    throw new Error('🔐 sub2api 登录态已经失效，请重新导出登录态。')
  }

  for (const result of responseResults) {
    if (result.kind !== 'required') continue
    const status = result.response.status()
    diagnostics.event(`api.${phase}.response`, `${result.name}接口响应`, {
      status,
      durationMs: Date.now() - startedAt,
    })
    if (status === 401 || status === 403) {
      throw new Error(`🔐 sub2api 返回 ${status}，当前登录态无权访问管理仪表盘或已经失效。`)
    }
    if (status >= 400) {
      throw new Error(`📡 ${result.name}接口返回 HTTP ${status}。`)
    }
  }
}

export async function applyTrendTimeRange(
  page: Page,
  range: TrendTimeRange,
  timeoutMs: number,
): Promise<void> {
  const filterSelector = TREND_REGION_SELECTORS.filter
  const dateTriggerSelector = `${filterSelector} .date-picker-trigger`
  const dateInputsSelector = `${filterSelector} input[type="date"]`
  const dateApplySelector = `${filterSelector} .date-picker-apply`
  const granularityTriggerSelector = `${filterSelector} button[aria-label="Select option"]`
  const granularityOptionsSelector = '.select-dropdown-portal [role="option"]'

  await page.click(dateTriggerSelector)
  await page.waitForSelector(dateInputsSelector, { timeout: timeoutMs })
  const inputCount = await page.$$eval(dateInputsSelector, (inputs, values) => {
    const [startInput, endInput] = inputs as HTMLInputElement[]
    if (!startInput || !endInput) return inputs.length

    startInput.value = values.startDate
    startInput.dispatchEvent(new Event('input', { bubbles: true }))
    startInput.dispatchEvent(new Event('change', { bubbles: true }))
    endInput.value = values.endDate
    endInput.dispatchEvent(new Event('input', { bubbles: true }))
    endInput.dispatchEvent(new Event('change', { bubbles: true }))
    return inputs.length
  }, {
    startDate: range.startDate,
    endDate: range.endDate,
  })
  if (inputCount < 2) {
    throw new Error('📅 找不到 sub2api 日期范围输入框。')
  }
  await page.click(dateApplySelector)

  await page.click(granularityTriggerSelector)
  await page.waitForSelector(granularityOptionsSelector, { timeout: timeoutMs })
  const options = await page.$$(granularityOptionsSelector)
  const desiredIndex = range.granularity === 'day' ? 0 : 1
  const desiredOption = options[desiredIndex]
  if (!desiredOption) {
    await Promise.all(options.map(option => option.dispose().catch(() => undefined)))
    throw new Error('🕒 找不到 sub2api day/hour 粒度选项。')
  }

  const alreadySelected = await desiredOption.evaluate((element) => {
    return element.getAttribute('aria-selected') === 'true'
  })
  if (alreadySelected) {
    await page.click(granularityTriggerSelector)
  } else {
    await desiredOption.click()
  }
  await Promise.all(options.map(option => option.dispose().catch(() => undefined)))
}

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
  diagnostics: CaptureDiagnostics,
  forceDarkTheme = false,
): Promise<void> {
  const authState = await prepareRuntimeAuthState(page, config, diagnostics)
  await injectAuthStorage(page, authState.storage, forceDarkTheme)
  diagnostics.event('auth.storage.injected', '登录态已注入新页面', {
    forceDarkTheme,
  })
}

function isRetryableAuthCaptureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /(?:sub2api 返回 40[13]|登录态已经失效|页面跳到了 \/login|refresh_token 已被轮换)/u.test(message)
}

async function captureStatusScreenshotOnce(
  ctx: Context,
  config: Config,
  diagnostics: CaptureDiagnostics,
  attempt: number,
): Promise<Buffer> {
  let page: Page | undefined

  try {
    page = await ctx.puppeteer.page()
    diagnostics.event('page.created', '已创建状态页浏览器页面')
    const statusPageUrl = getSub2apiPageUrl(config.sub2apiBaseUrl, '/monitor')
    await page.setViewport({
      width: config.viewportWidth,
      height: config.viewportHeight,
      deviceScaleFactor: config.deviceScaleFactor,
    })
    diagnostics.event('page.viewport', '状态页视口设置完成', {
      width: config.viewportWidth,
      height: config.viewportHeight,
      deviceScaleFactor: config.deviceScaleFactor,
    })
    await prepareAuthenticatedPage(page, config, diagnostics)

    const navigationStartedAt = Date.now()
    const channelMonitorResponse = page.waitForResponse((response) => {
      const url = response.url()
      return response.request().method() === 'GET'
        && url.includes('/channel-monitors')
        && !url.includes('/admin/')
    }, { timeout: config.navigationTimeoutMs }).catch(() => null)

    diagnostics.event('page.navigate.start', '开始导航到状态页', {
      path: '/monitor',
      waitUntil: config.waitUntil,
    })
    await page.goto(statusPageUrl, {
      waitUntil: config.waitUntil,
      timeout: config.navigationTimeoutMs,
    })
    diagnostics.event('page.navigate.ok', '状态页导航完成', {
      durationMs: Date.now() - navigationStartedAt,
    })
    const selectorStartedAt = Date.now()
    await page.waitForSelector(config.waitForSelector, {
      timeout: config.navigationTimeoutMs,
    })
    diagnostics.event('page.selector.ok', '状态页目标选择器已经出现', {
      selector: config.waitForSelector,
      durationMs: Date.now() - selectorStartedAt,
    })

    const response = await channelMonitorResponse
    diagnostics.event('api.channel-monitor.response', '渠道状态接口等待完成', {
      status: response?.status() ?? null,
      durationMs: Date.now() - navigationStartedAt,
    })
    if (response?.status() === 401) {
      throw new Error('🔐 sub2api 返回 401，登录态已失效或 refresh_token 已被轮换。请重新导出登录态。')
    }

    await sleep(config.waitAfterLoadedMs)
    diagnostics.event('page.wait.complete', '状态页额外等待完成', {
      waitAfterLoadedMs: config.waitAfterLoadedMs,
    })
    await dismissOnboardingTour(page)
    diagnostics.event('page.onboarding.checked', '状态页新手引导遮罩检查完成')

    const currentPath = await page.evaluate(() => location.pathname)
    diagnostics.event('page.path.checked', '状态页最终路径检查完成', {
      path: currentPath,
    })
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
      diagnostics.event('screenshot.crop', '状态页裁剪区域计算完成', {
        pageSize,
        clip: screenshotOptions.clip,
      })
    } else {
      screenshotOptions.fullPage = config.fullPage
      diagnostics.event('screenshot.crop', '状态页不使用裁剪规则', {
        fullPage: config.fullPage,
      })
    }
    if (config.imageType !== 'png') {
      screenshotOptions.quality = config.imageQuality
    }

    const screenshotStartedAt = Date.now()
    diagnostics.event('screenshot.start', '开始生成状态页截图', {
      imageType: config.imageType,
    })
    const image = toImageBuffer(await page.screenshot(screenshotOptions))
    diagnostics.event('screenshot.complete', '状态页截图生成完成', {
      bytes: image.length,
      durationMs: Date.now() - screenshotStartedAt,
    })
    await diagnostics.persistSuccess(image, config.imageType, { attempt })
    return image
  } catch (error) {
    await diagnostics.persistFailure(
      error,
      page,
      config.imageType,
      config.imageQuality,
      { attempt },
    )
    throw error
  } finally {
    if (page) {
      await syncRuntimeAuthStateFromPage(page, config, diagnostics).catch((error) => {
        diagnostics.event('auth.sync.failed', '页面登录态回收失败', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
      await page.close().then(() => {
        diagnostics.event('page.closed', '状态页浏览器页面已经关闭')
      }).catch((error) => {
        diagnostics.event('page.close.failed', '状态页浏览器页面关闭失败', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
  }
}

export async function captureStatusScreenshot(ctx: Context, config: Config): Promise<Buffer> {
  const diagnostics = createCaptureDiagnostics(ctx, 'status', config, {
    waitUntil: config.waitUntil,
    waitAfterLoadedMs: config.waitAfterLoadedMs,
    navigationTimeoutMs: config.navigationTimeoutMs,
    deviceScaleFactor: config.deviceScaleFactor,
    viewportWidth: config.viewportWidth,
    viewportHeight: config.viewportHeight,
    waitForSelector: config.waitForSelector,
    fullPage: config.fullPage,
    cropRules: config.cropRules,
    imageType: config.imageType,
    imageQuality: config.imageQuality,
    autoRelogin: config.enableAutoRelogin,
  })
  diagnostics.startAttempt(1, { kind: 'status' })
  try {
    return await captureStatusScreenshotOnce(ctx, config, diagnostics, 1)
  } catch (error) {
    if (!config.enableAutoRelogin || !isRetryableAuthCaptureError(error)) throw error
    diagnostics.event('capture.retry', '检测到可恢复认证错误，准备刷新登录态后重试', {
      failedAttempt: 1,
    })
    markRuntimeAuthStateStale(config)
    diagnostics.startAttempt(2, { kind: 'status', previousAttemptFailed: true })
    return captureStatusScreenshotOnce(ctx, config, diagnostics, 2)
  }
}

async function captureTrendScreenshotOnce(
  ctx: Context,
  config: Config,
  diagnostics: CaptureDiagnostics,
  attempt: number,
  num?: number,
  unit?: string,
): Promise<Buffer> {
  let page: Page | undefined

  try {
    const timeRange = resolveTrendTimeRange(num, unit)
    const screenshotRegions = resolveTrendScreenshotRegions(config.trendScreenshotRange)
    const includesCharts = screenshotRegions.includes('charts')
    diagnostics.event('trend.range.resolved', '趋势时间与截图范围解析完成', {
      num: timeRange.num,
      granularity: timeRange.granularity,
      startDate: timeRange.startDate,
      endDate: timeRange.endDate,
      regions: screenshotRegions,
    })
    page = await ctx.puppeteer.page()
    diagnostics.event('page.created', '已创建趋势页浏览器页面')
    const dashboardUrl = getSub2apiPageUrl(config.sub2apiBaseUrl, '/admin/dashboard')
    await page.setViewport({
      width: TREND_VIEWPORT_WIDTH,
      height: TREND_VIEWPORT_HEIGHT,
      deviceScaleFactor: config.deviceScaleFactor,
    })
    diagnostics.event('page.viewport', '趋势页视口设置完成', {
      width: TREND_VIEWPORT_WIDTH,
      height: TREND_VIEWPORT_HEIGHT,
      deviceScaleFactor: config.deviceScaleFactor,
    })
    await prepareAuthenticatedPage(page, config, diagnostics, true)

    await waitForTrendApiResponses(
      page,
      config.navigationTimeoutMs,
      includesCharts,
      undefined,
      () => page.goto(dashboardUrl, {
        waitUntil: config.waitUntil,
        timeout: config.navigationTimeoutMs,
      }),
      diagnostics,
      'initial',
    )
    diagnostics.event('page.navigate.ok', '趋势页首次导航与接口加载完成', {
      path: '/admin/dashboard',
    })

    const markerStartedAt = Date.now()
    await page.waitForFunction(() => {
      const headings = Array.from(document.querySelectorAll('h3'))
      const heading = headings.find((element) => {
        const text = element.textContent?.trim() || ''
        return /Top\s*12/i.test(text) || text.includes('最近使用')
      })
      const card = heading?.closest('.card')
      if (!card) return false

      const charts = card.previousElementSibling
      const filter = charts?.previousElementSibling
      card.setAttribute('data-sub2api-trend-card', 'true')
      charts?.setAttribute('data-sub2api-trend-charts', 'true')
      filter?.setAttribute('data-sub2api-trend-filter', 'true')
      return true
    }, { timeout: config.navigationTimeoutMs })
    diagnostics.event('page.regions.marked', '趋势页 A/B/C 区域定位完成', {
      durationMs: Date.now() - markerStartedAt,
    })

    await sleep(Math.max(config.waitAfterLoadedMs, 1200))
    await dismissOnboardingTour(page)
    diagnostics.event('page.onboarding.checked', '趋势页新手引导遮罩检查完成', {
      waitAfterLoadedMs: Math.max(config.waitAfterLoadedMs, 1200),
    })

    const currentPath = await page.evaluate(() => location.pathname)
    diagnostics.event('page.path.checked', '趋势页最终路径检查完成', {
      path: currentPath,
    })
    if (currentPath.startsWith('/login')) {
      throw new Error('🚪 页面跳到了 /login，说明 localStorage 登录态没有生效。')
    }

    await waitForTrendApiResponses(
      page,
      config.navigationTimeoutMs,
      includesCharts,
      timeRange,
      () => applyTrendTimeRange(page, timeRange, config.navigationTimeoutMs),
      diagnostics,
      'range',
    )
    await sleep(Math.max(config.waitAfterLoadedMs, 1200))
    diagnostics.event('trend.range.applied', '趋势时间范围已经应用并完成额外等待', {
      waitAfterLoadedMs: Math.max(config.waitAfterLoadedMs, 1200),
    })

    const trendCard = await page.$('[data-sub2api-trend-card="true"]')
    if (!trendCard) {
      throw new Error('🎯 找不到最近使用趋势图表组件。')
    }
    const canvasWaitTimeoutMs = Math.min(config.navigationTimeoutMs, 10000)
    const recentCanvasResult = await waitForStableCanvases(
      page,
      TREND_REGION_SELECTORS.recent,
      1,
      canvasWaitTimeoutMs,
    )
    diagnostics.event(
      recentCanvasResult.stable ? 'canvas.recent.stable' : 'canvas.recent.timeout',
      recentCanvasResult.stable ? '最近使用 Canvas 已稳定' : '最近使用 Canvas 稳定等待超时',
      {
        polls: recentCanvasResult.polls,
        durationMs: recentCanvasResult.durationMs,
        probes: recentCanvasResult.probes,
      },
    )
    if (!recentCanvasResult.stable) {
      throw new Error('📭 最近使用趋势暂无数据。')
    }

    if (includesCharts) {
      const charts = await page.$(TREND_REGION_SELECTORS.charts)
      if (!charts) {
        throw new Error('🎯 找不到模型分布与 Token 使用趋势区域。')
      }
      const chartCanvasResult = await waitForStableCanvases(
        page,
        TREND_REGION_SELECTORS.charts,
        2,
        canvasWaitTimeoutMs,
      )
      diagnostics.event(
        chartCanvasResult.stable ? 'canvas.charts.stable' : 'canvas.charts.timeout',
        chartCanvasResult.stable ? '模型分布与 Token 趋势 Canvas 已稳定' : '模型分布与 Token 趋势 Canvas 稳定等待超时',
        {
          polls: chartCanvasResult.polls,
          durationMs: chartCanvasResult.durationMs,
          probes: chartCanvasResult.probes,
        },
      )
      if (!chartCanvasResult.stable) {
        throw new Error('📭 模型分布或 Token 使用趋势暂无可截图数据。')
      }
    }

    const regionRects = await page.evaluate(({
      regions,
      selectors,
    }: {
      regions: TrendScreenshotRegion[]
      selectors: Record<TrendScreenshotRegion, string>
    }) => {
      return regions.map((region) => {
        const element = document.querySelector(selectors[region])
        if (!element) return null

        const rect = element.getBoundingClientRect()
        return {
          x: rect.left + window.scrollX,
          y: rect.top + window.scrollY,
          width: rect.width,
          height: rect.height,
        }
      })
    }, {
      regions: screenshotRegions,
      selectors: TREND_REGION_SELECTORS,
    })
    if (regionRects.some(rect => rect === null)) {
      throw new Error('🎯 找不到所选的完整趋势截图区域，sub2api 页面结构可能已经变化。')
    }
    const clip = mergeTrendScreenshotRects(regionRects as TrendScreenshotRect[])
    diagnostics.event('screenshot.clip', '趋势截图联合区域计算完成', {
      regions: screenshotRegions,
      clip,
    })

    const screenshotOptions: any = {
      type: config.imageType,
      clip,
      captureBeyondViewport: true,
    }
    if (config.imageType !== 'png') {
      screenshotOptions.quality = config.imageQuality
    }

    const screenshotStartedAt = Date.now()
    diagnostics.event('screenshot.start', '开始生成趋势截图', {
      imageType: config.imageType,
    })
    const image = toImageBuffer(await page.screenshot(screenshotOptions))
    diagnostics.event('screenshot.complete', '趋势截图生成完成', {
      bytes: image.length,
      durationMs: Date.now() - screenshotStartedAt,
    })
    await diagnostics.persistSuccess(image, config.imageType, {
      attempt,
      range: {
        num: timeRange.num,
        granularity: timeRange.granularity,
        startDate: timeRange.startDate,
        endDate: timeRange.endDate,
      },
      regions: screenshotRegions,
      clip,
    })
    return image
  } catch (error) {
    await diagnostics.persistFailure(
      error,
      page,
      config.imageType,
      config.imageQuality,
      { attempt, num: num ?? 24, unit: unit ?? 'hour' },
    )
    throw error
  } finally {
    if (page) {
      await syncRuntimeAuthStateFromPage(page, config, diagnostics).catch((error) => {
        diagnostics.event('auth.sync.failed', '页面登录态回收失败', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
      await page.close().then(() => {
        diagnostics.event('page.closed', '趋势页浏览器页面已经关闭')
      }).catch((error) => {
        diagnostics.event('page.close.failed', '趋势页浏览器页面关闭失败', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
  }
}

export async function captureTrendScreenshot(
  ctx: Context,
  config: Config,
  num?: number,
  unit?: string,
): Promise<Buffer> {
  const diagnostics = createCaptureDiagnostics(ctx, 'trend', config, {
    waitUntil: config.waitUntil,
    waitAfterLoadedMs: config.waitAfterLoadedMs,
    navigationTimeoutMs: config.navigationTimeoutMs,
    deviceScaleFactor: config.deviceScaleFactor,
    viewportWidth: TREND_VIEWPORT_WIDTH,
    viewportHeight: TREND_VIEWPORT_HEIGHT,
    trendScreenshotRange: config.trendScreenshotRange,
    imageType: config.imageType,
    imageQuality: config.imageQuality,
    autoRelogin: config.enableAutoRelogin,
    requestedNum: num ?? 24,
    requestedUnit: unit ?? 'hour',
  })
  diagnostics.startAttempt(1, { kind: 'trend' })
  try {
    return await captureTrendScreenshotOnce(ctx, config, diagnostics, 1, num, unit)
  } catch (error) {
    if (!config.enableAutoRelogin || !isRetryableAuthCaptureError(error)) throw error
    diagnostics.event('capture.retry', '检测到可恢复认证错误，准备刷新登录态后重试', {
      failedAttempt: 1,
    })
    markRuntimeAuthStateStale(config)
    diagnostics.startAttempt(2, { kind: 'trend', previousAttemptFailed: true })
    return captureTrendScreenshotOnce(ctx, config, diagnostics, 2, num, unit)
  }
}
