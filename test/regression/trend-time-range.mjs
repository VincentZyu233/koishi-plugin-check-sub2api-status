import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

import { formatError, logError, logSuccess } from '../shared/console-style.mjs'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(TEST_DIR, '..', '..')
const RANGE_SOURCE = path.join(PLUGIN_ROOT, 'src', 'utils.ts')

/**
 * Keep this test independent from Koishi and a live sub2api instance. The small
 * TypeScript module is bundled in memory so aliases and calendar calculations are
 * checked against current source without generating files in test/ or temp/.
 */
async function loadRangeModule() {
  const result = await build({
    absWorkingDir: PLUGIN_ROOT,
    entryPoints: [RANGE_SOURCE],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
  })

  assert.equal(result.outputFiles.length, 1, 'esbuild should return one in-memory bundle')

  const filename = path.join(TEST_DIR, '.trend-time-range.bundle.cjs')
  const requireFromPlugin = createRequire(path.join(PLUGIN_ROOT, 'package.json'))
  const compiledModule = { exports: {} }
  const executeBundle = new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    result.outputFiles[0].text,
  )

  executeBundle(
    requireFromPlugin,
    compiledModule,
    compiledModule.exports,
    filename,
    TEST_DIR,
  )
  return compiledModule.exports
}

async function main() {
  const { resolveTrendTimeRange, TREND_UNIT_HELP } = await loadRangeModule()
  assert.equal(typeof resolveTrendTimeRange, 'function')

  // Use a local-time Date constructor because production calculations intentionally
  // follow the Koishi/browser machine timezone instead of UTC calendar boundaries.
  const now = new Date(2026, 6, 22, 15, 30, 0)

  assert.deepEqual(resolveTrendTimeRange(undefined, undefined, now), {
    num: 24,
    granularity: 'hour',
    startDate: '2026-07-21',
    endDate: '2026-07-22',
  })
  assert.deepEqual(resolveTrendTimeRange(7, 'day', now), {
    num: 7,
    granularity: 'day',
    startDate: '2026-07-16',
    endDate: '2026-07-22',
  })
  assert.deepEqual(resolveTrendTimeRange(1, '日', now), {
    num: 1,
    granularity: 'day',
    startDate: '2026-07-22',
    endDate: '2026-07-22',
  })
  assert.deepEqual(resolveTrendTimeRange(6, '小时', now), {
    num: 6,
    granularity: 'hour',
    startDate: '2026-07-22',
    endDate: '2026-07-22',
  })

  const hourAliases = ['h', 'hr', 'hour', 'hours', '时', '小时', 'H', 'HOURS']
  for (const alias of hourAliases) {
    assert.equal(resolveTrendTimeRange(1, alias, now).granularity, 'hour')
  }
  const dayAliases = ['d', 'day', 'days', '天', '日', 'D', 'DAYS']
  for (const alias of dayAliases) {
    assert.equal(resolveTrendTimeRange(1, alias, now).granularity, 'day')
  }

  assert.equal(
    TREND_UNIT_HELP,
    'h/hr/hour/hours/时/小时/d/day/days/天/日',
  )
  assert.throws(() => resolveTrendTimeRange(0, 'h', now), /正整数/u)
  assert.throws(() => resolveTrendTimeRange(1.5, 'h', now), /正整数/u)
  assert.throws(() => resolveTrendTimeRange(169, 'h', now), /不能超过 168/u)
  assert.throws(() => resolveTrendTimeRange(366, 'd', now), /不能超过 365/u)
  assert.throws(() => resolveTrendTimeRange(1, 'week', now), /不支持的时间单位/u)

  logSuccess('trend-time-range：全部检查通过')
}

main().catch((error) => {
  logError('trend-time-range：检查失败', formatError(error))
  process.exitCode = 1
})
