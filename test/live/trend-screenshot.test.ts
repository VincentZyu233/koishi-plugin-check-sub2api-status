import { runLiveScreenshotBatch } from './live-screenshot-harness'

/**
 * Live regression entry for the administrator dashboard trend page.
 *
 * With no arguments this reproduces the Koishi plugin configuration and the command's
 * default 24-hour range. Use CLI overrides for controlled A/B runs without editing the
 * real Koishi configuration. Each attempt opens and closes a fresh page while reusing
 * one Chromium process for the whole batch.
 *
 * Example:
 *   npm run test:live-trend -- --wait-until load --wait-after-loaded-ms 8000
 */
export async function run(args: string[]): Promise<void> {
  await runLiveScreenshotBatch('trend', args)
}
