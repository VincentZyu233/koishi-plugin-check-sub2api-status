import { Context, h } from 'koishi'

import type { Config } from './config'
import { captureStatusScreenshot, captureTrendScreenshot } from './puppeteer'
import { mimeTypeOf } from './utils'

interface ScreenshotCommandOptions {
  commandName: string
  description: string
  waitingText: string
  logName: string
  capture: () => Promise<Buffer>
}

function registerScreenshotCommand(
  ctx: Context,
  config: Config,
  options: ScreenshotCommandOptions,
): void {
  const logger = ctx.logger('check-sub2api-status')

  ctx.command(options.commandName, options.description)
    .action(async ({ session }) => {
      let waitingHintMsgId: string | undefined

      try {
        if (config.enableWaitingHint && session) {
          const quote = config.enableQuote && session.messageId ? `${h.quote(session.messageId)}` : ''
          const sentIds = await session
            .send(`${quote}${options.waitingText}`)
            .catch((error) => {
              logger.warn(`⏳ 等待提示发送失败：${error instanceof Error ? error.message : String(error)}`)
              return []
            })
          waitingHintMsgId = sentIds[0]
        }

        const image = await options.capture()
        if (config.verboseLog) {
          logger.info(`${options.logName} screenshot ok: ${image.length} bytes`)
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
      }
    })
}

export function registerStatusCommand(ctx: Context, config: Config): void {
  registerScreenshotCommand(ctx, config, {
    commandName: config.statusCommandName,
    description: '截图 sub2api 渠道状态页',
    waitingText: '📡 获取 sub2api 状态中，请稍后... ⏳',
    logName: 'sub2api monitor',
    capture: () => captureStatusScreenshot(ctx, config),
  })
}

export function registerTrendCommand(ctx: Context, config: Config): void {
  registerScreenshotCommand(ctx, config, {
    commandName: config.trendCommandName,
    description: '截图 sub2api 最近使用趋势',
    waitingText: '📈 获取 sub2api 最近使用趋势中，请稍后... ⏳',
    logName: 'sub2api trend',
    capture: () => captureTrendScreenshot(ctx, config),
  })
}
