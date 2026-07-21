import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(TEST_DIR, '..')
const PUPPETEER_SOURCE = path.join(PLUGIN_ROOT, 'src', 'puppeteer.ts')
const CONFIG_SOURCE = path.join(PLUGIN_ROOT, 'src', 'config.ts')

/**
 * The screenshot implementation lives in TypeScript and the project only emits
 * declaration files during its normal type-check. Build it in memory so this test
 * executes the current source without leaving a generated bundle in temp/ or test/.
 */
async function loadScreenshotModule() {
  const result = await build({
    absWorkingDir: PLUGIN_ROOT,
    entryPoints: [PUPPETEER_SOURCE],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
    external: [
      'koishi',
      'koishi-plugin-puppeteer',
      'puppeteer-core',
    ],
  })

  assert.equal(result.outputFiles.length, 1, 'esbuild should return one in-memory bundle')

  const filename = path.join(TEST_DIR, '.trend-screenshot-range.bundle.cjs')
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

/**
 * These fixtures mirror the dashboard layout without depending on a live sub2api.
 * A is the date filter, B is the two-chart grid, and C is the recent-usage card.
 * Fractional A coordinates also verify that clipping rounds outward instead of
 * accidentally trimming a one-pixel border after browser layout calculations.
 */
const REGIONS = {
  filter: { x: 24.2, y: 12.7, width: 1543.4, height: 75.2 },
  charts: { x: 24, y: 112, width: 1544, height: 274 },
  recent: { x: 24, y: 410, width: 1544, height: 324 },
}

/**
 * Model the two official controls used by DashboardView without opening Chrome.
 * This records the selector sequence and catches a subtle regression where Escape
 * would leave Select.vue's teleported dropdown visible when the desired option was
 * already selected on its trigger button.
 */
function makeDashboardControlsPage(selectedIndex) {
  const pageClicks = []
  const optionClicks = []
  const inputEvents = []
  const inputValues = ['', '']

  const options = [0, 1].map(index => ({
    async evaluate(callback) {
      return callback({
        getAttribute(name) {
          return name === 'aria-selected' ? String(index === selectedIndex) : null
        },
      })
    },
    async click() {
      optionClicks.push(index)
    },
    async dispose() {},
  }))

  return {
    page: {
      async click(selector) {
        pageClicks.push(selector)
      },
      async waitForSelector() {},
      async $$eval(_selector, callback, values) {
        const inputs = [0, 1].map(index => ({
          get value() {
            return inputValues[index]
          },
          set value(value) {
            inputValues[index] = value
          },
          dispatchEvent(event) {
            inputEvents.push(`${index}:${event.type}`)
          },
        }))
        return callback(inputs, values)
      },
      async $$() {
        return options
      },
    },
    pageClicks,
    optionClicks,
    inputEvents,
    inputValues,
  }
}

async function assertConfigDescriptionsHaveEmoji() {
  const source = await readFile(CONFIG_SOURCE, 'utf8')
  const descriptionLines = source
    .split(/\r?\n/u)
    .filter(line => line.includes('.description('))
  const emojiPattern = /[\u{2190}-\u{2BFF}\u{1F000}-\u{1FAFF}]/u

  assert.ok(descriptionLines.length > 0, 'config.ts should contain descriptions')
  for (const line of descriptionLines) {
    assert.match(line, emojiPattern, `description is missing an emoji: ${line.trim()}`)
  }
  assert.match(
    source,
    /\.default\(TREND_SCREENSHOT_RANGES\.ALL\)/u,
    'A + B + C should remain the default screenshot range',
  )
}

async function main() {
  const {
    applyTrendTimeRange,
    mergeTrendScreenshotRects,
    resolveTrendScreenshotRegions,
  } = await loadScreenshotModule()

  assert.equal(typeof applyTrendTimeRange, 'function')
  assert.equal(typeof mergeTrendScreenshotRects, 'function')
  assert.equal(typeof resolveTrendScreenshotRegions, 'function')

  // Old saved configurations can briefly omit the new field during migration.
  // Treating undefined as "all" keeps the runtime aligned with the Schema default.
  assert.deepEqual(resolveTrendScreenshotRegions(undefined), ['filter', 'charts', 'recent'])
  assert.deepEqual(resolveTrendScreenshotRegions('all'), ['filter', 'charts', 'recent'])
  assert.deepEqual(resolveTrendScreenshotRegions('charts-and-recent'), ['charts', 'recent'])
  assert.deepEqual(resolveTrendScreenshotRegions('recent-only'), ['recent'])
  assert.throws(
    () => resolveTrendScreenshotRegions('unsupported'),
    /不支持的趋势截图范围/u,
  )

  assert.deepEqual(
    mergeTrendScreenshotRects([REGIONS.filter, REGIONS.charts, REGIONS.recent]),
    { x: 24, y: 12, width: 1544, height: 722 },
  )
  assert.deepEqual(
    mergeTrendScreenshotRects([REGIONS.charts, REGIONS.recent]),
    { x: 24, y: 112, width: 1544, height: 622 },
  )
  assert.deepEqual(
    mergeTrendScreenshotRects([REGIONS.recent]),
    REGIONS.recent,
  )
  assert.throws(
    () => mergeTrendScreenshotRects([]),
    /趋势截图区域尺寸无效/u,
  )

  const dayControls = makeDashboardControlsPage(0)
  await applyTrendTimeRange(dayControls.page, {
    num: 7,
    granularity: 'day',
    startDate: '2026-07-16',
    endDate: '2026-07-22',
  }, 1000)
  assert.deepEqual(dayControls.inputValues, ['2026-07-16', '2026-07-22'])
  assert.deepEqual(dayControls.inputEvents, [
    '0:input',
    '0:change',
    '1:input',
    '1:change',
  ])
  assert.equal(dayControls.pageClicks.at(-2), '[data-sub2api-trend-filter="true"] button[aria-label="Select option"]')
  assert.equal(dayControls.pageClicks.at(-1), '[data-sub2api-trend-filter="true"] button[aria-label="Select option"]')
  assert.deepEqual(dayControls.optionClicks, [])

  const hourControls = makeDashboardControlsPage(0)
  await applyTrendTimeRange(hourControls.page, {
    num: 48,
    granularity: 'hour',
    startDate: '2026-07-20',
    endDate: '2026-07-22',
  }, 1000)
  assert.deepEqual(hourControls.optionClicks, [1])

  await assertConfigDescriptionsHaveEmoji()
  console.log('trend-screenshot-range: all checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
