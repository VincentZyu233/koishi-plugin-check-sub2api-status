import { Context, h } from 'koishi'

import { readAuthState } from './auth'
import type { Config } from './config'
import { CROP_DIRECTIONS } from './types'
import { mimeTypeOf, sleep } from './utils'

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

export function registerStatusCommand(ctx: Context, config: Config) {
  const logger = ctx.logger('check-sub2api-status')

  ctx.command(config.commandName, '截图 sub2api 渠道状态页')
    .action(async ({ session }) => {
      const page = await ctx.puppeteer.page()
      const monitorUrl = config.monitorUrl.trim()
      let waitingHintMsgId: string | undefined

      try {
        if (config.enableWaitingHint && session) {
          const quote = config.enableQuote && session.messageId ? `${h.quote(session.messageId)}` : ''
          const sentIds = await session
            .send(`${quote}📡 获取 sub2api 状态中，请稍后... ⏳`)
            .catch((error) => {
              logger.warn(`⏳ 等待提示发送失败：${error instanceof Error ? error.message : String(error)}`)
              return []
            })
          waitingHintMsgId = sentIds[0]
        }

        const authStorage = await readAuthState(config)
        await page.setViewport({
          width: config.viewportWidth,
          height: config.viewportHeight,
          deviceScaleFactor: config.deviceScaleFactor,
        })

        await page.evaluateOnNewDocument((entries) => {
          for (const [key, value] of Object.entries(entries)) {
            if (value !== undefined && value !== null) {
              localStorage.setItem(key, String(value))
            }
          }
        }, authStorage)

        const channelMonitorResponse = page.waitForResponse((response) => {
          const url = response.url()
          return response.request().method() === 'GET'
            && url.includes('/channel-monitors')
            && !url.includes('/admin/')
        }, { timeout: config.navigationTimeoutMs }).catch(() => null)

        await page.goto(monitorUrl, {
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

        const rawImage = await page.screenshot(screenshotOptions)
        const image = typeof rawImage === 'string'
          ? Buffer.from(rawImage, 'base64')
          : Buffer.isBuffer(rawImage)
            ? rawImage
            : Buffer.from(rawImage)
        if (config.verboseLog) {
          logger.info(`sub2api monitor screenshot ok: ${image.length} bytes`)
        }

        const quote = config.enableQuote && session?.messageId ? `${h.quote(session.messageId)}` : ''
        return `${quote}${h.image(image, mimeTypeOf(config.imageType))}`
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn(message)
        const quote = config.enableQuote && session?.messageId ? `${h.quote(session.messageId)}` : ''
        return `${quote}截图失败：${message}`
      } finally {
        if (waitingHintMsgId && session?.channelId) {
          await session.bot.deleteMessage(session.channelId, waitingHintMsgId).catch(() => undefined)
        }
        await page.close().catch(() => undefined)
      }
    })
}
