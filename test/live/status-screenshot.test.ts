import { runLiveScreenshotBatch } from './live-screenshot-harness'

/**
 * Live regression entry for the channel status page.
 *
 * The harness reads the active check-sub2api-status block from the Koishi workspace config,
 * applies src/config.ts defaults, then applies only explicit CLI overrides. Tokens,
 * exported auth state, and User-Agent values are never printed or copied to fixtures.
 *
 * Example:
 *   npm run test:live-status -- --waitAfterLoadedMs 8000 --count 5
 */
export async function run(args: string[]): Promise<void> {
  await runLiveScreenshotBatch('status', args)
}
