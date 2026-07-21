import { Context } from 'koishi'
import {} from 'koishi-plugin-puppeteer'

import { registerStatusCommand, registerTrendCommand } from './command'
import type { Config as CheckSub2apiStatusConfig } from './config'
import { Config as ConfigSchema } from './config'

export const name = 'check-sub2api-status'
export const reusable = true;

export const inject = ['puppeteer']

export const Config = ConfigSchema

export function apply(ctx: Context, config: CheckSub2apiStatusConfig) {
  if (config.enableStatusCommand) registerStatusCommand(ctx, config)
  if (config.enableTrendCommand) registerTrendCommand(ctx, config)
}
