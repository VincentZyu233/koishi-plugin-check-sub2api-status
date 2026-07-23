import { Context, h } from 'koishi'

import type { Config } from './config'
import { captureStatusScreenshot, captureTrendScreenshot } from './puppeteer'
import { mimeTypeOf } from './utils'

interface ScreenshotCommandOptions {
  commandName: string
  description: string
  waitingText: string
  capture: (...args: any[]) => Promise<Buffer>
}

function registerScreenshotCommand(
  ctx: Context,
  config: Config,
  options: ScreenshotCommandOptions,
): void {
  const logger = ctx.logger('check-sub2api-status')

  ctx.command(options.commandName, options.description)
    .action(async ({ session }, ...args) => {
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

        const image = await options.capture(...args)

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
    waitingText: '📡 获取 sub2api 上游渠道状态中，请稍后... ⏳',
    capture: () => captureStatusScreenshot(ctx, config),
  })
}

export function registerTrendCommand(ctx: Context, config: Config): void {
  registerScreenshotCommand(ctx, config, {
    commandName: `${config.trendCommandName} [num:number] [unit:string]`,
    description: [
      '📈📅 截图 sub2api 管理仪表盘趋势。',
      'num：正整数；hour 范围 1–168，day 范围 1–365。',
      'unit：h/hr/hour/hours/时/小时，或 d/day/days/天/日；英文忽略大小写。',
      '默认：不传参数时为 24 hour，只传 num 时 unit 默认为 hour。',
    ].join('\n'),
    waitingText: '📈 获取 sub2api 管理仪表盘趋势中，请稍后... ⏳',
    capture: (num?: number, unit?: string) => captureTrendScreenshot(ctx, config, num, unit),
  })
}
