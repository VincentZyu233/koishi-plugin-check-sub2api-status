import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import NodeLoader from '@koishijs/loader'
import type { Context } from 'koishi'
import puppeteer, { type Browser } from 'puppeteer-core'

import type { Config } from '../../src/config'
import { Config as ConfigSchema } from '../../src/config'
import { captureStatusScreenshot, captureTrendScreenshot } from '../../src/puppeteer'
import type { CropRule, ImageType, TrendScreenshotRange, WaitUntil } from '../../src/types'
import {
  logError,
  logHelp,
  logInfo,
  logPath,
  logStep,
  logSuccess,
  logSummary,
  logWarning,
} from '../shared/console-style.mjs'

type ScreenshotKind = 'status' | 'trend'
type PluginConfig = Record<string, unknown>
type PuppeteerLaunchOptions = NonNullable<Parameters<typeof puppeteer.launch>[0]>

interface ParsedCli {
  configPath: string
  outputDir: string
  count: number
  intervalMs: number
  browserLaunchTimeoutMs: number
  executablePath?: string
  headless?: boolean
  configOverrides: Partial<Config>
  trendNum?: number
  trendUnit?: string
  help: boolean
}

interface BatchResult {
  index: number
  filename?: string
  elapsedMs: number
  error?: string
}

const TEST_DIR = __dirname
const PLUGIN_ROOT = path.resolve(TEST_DIR, '..', '..')
const DEFAULT_KOISHI_CONFIG = path.resolve(PLUGIN_ROOT, '..', '..', 'koishi.yml')
const DEFAULT_OUTPUT_DIR = path.resolve(TEST_DIR, '..', 'output')
const BOOLEAN_OPTIONS = new Set([
  'enable-auto-relogin',
  'enable-custom-user-agent',
  'full-page',
  'headless',
  'help',
  'verbose-console-log',
  'verbose-file-log',
])
const COMMON_CONFIG_OPTIONS: Record<string, keyof Config> = {
  'sub2api-base-url': 'sub2apiBaseUrl',
  'enable-auto-relogin': 'enableAutoRelogin',
  'enable-custom-user-agent': 'enableCustomUserAgent',
  'custom-user-agent': 'customUserAgent',
  'wait-until': 'waitUntil',
  'wait-after-loaded-ms': 'waitAfterLoadedMs',
  'navigation-timeout-ms': 'navigationTimeoutMs',
  'device-scale-factor': 'deviceScaleFactor',
  'image-type': 'imageType',
  'image-quality': 'imageQuality',
  'verbose-console-log': 'verboseConsoleLog',
  'verbose-file-log': 'verboseFileLog',
  'verbose-file-log-retention': 'verboseFileLogRetention',
}
const STATUS_CONFIG_OPTIONS: Record<string, keyof Config> = {
  'viewport-width': 'viewportWidth',
  'viewport-height': 'viewportHeight',
  'wait-for-selector': 'waitForSelector',
  'full-page': 'fullPage',
  'crop-rules-json': 'cropRules',
}
const TREND_CONFIG_OPTIONS: Record<string, keyof Config> = {
  'trend-screenshot-range': 'trendScreenshotRange',
}

function normalizeOptionName(name: string): string {
  return name
    .replace(/^--/u, '')
    .replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`)
}

function parseBoolean(value: string, optionName: string): boolean {
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new Error(`--${optionName} 只接受 true/false 或 1/0。`)
}

function parseFiniteNumber(value: string, optionName: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${optionName} 必须是有限数字，当前值为 ${value}。`)
  }
  return parsed
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = parseFiniteNumber(value, optionName)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${optionName} 必须是正整数，当前值为 ${value}。`)
  }
  return parsed
}

function readOptionTokens(argv: string[]): Map<string, string> {
  const options = new Map<string, string>()

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      throw new Error(`无法识别的位置参数：${token}。参数必须使用 --name value。`)
    }

    const equalIndex = token.indexOf('=')
    const rawName = equalIndex >= 0 ? token.slice(0, equalIndex) : token
    const negated = rawName.startsWith('--no-')
    const normalizedName = normalizeOptionName(negated ? rawName.slice(5) : rawName)
    let value = equalIndex >= 0 ? token.slice(equalIndex + 1) : undefined

    if (negated) {
      if (!BOOLEAN_OPTIONS.has(normalizedName)) {
        throw new Error(`--no-${normalizedName} 不是布尔参数。`)
      }
      value = 'false'
    } else if (value === undefined && BOOLEAN_OPTIONS.has(normalizedName)) {
      const next = argv[index + 1]
      if (next === 'true' || next === 'false' || next === '1' || next === '0') {
        value = next
        index += 1
      } else {
        value = 'true'
      }
    } else if (value === undefined) {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--${normalizedName} 缺少参数值。`)
      }
      value = next
      index += 1
    }

    if (options.has(normalizedName)) {
      throw new Error(`--${normalizedName} 重复传入。`)
    }
    options.set(normalizedName, value)
  }

  return options
}

function parseCropRules(value: string): CropRule[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error(`--crop-rules-json 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error('--crop-rules-json 必须是 JSON 数组。')
  }
  return parsed as CropRule[]
}

function assignConfigOverride(
  overrides: Partial<Config>,
  configKey: keyof Config,
  optionName: string,
  value: string,
): void {
  if (configKey === 'enableAutoRelogin'
    || configKey === 'enableCustomUserAgent'
    || configKey === 'fullPage'
    || configKey === 'verboseConsoleLog'
    || configKey === 'verboseFileLog') {
    Object.assign(overrides, { [configKey]: parseBoolean(value, optionName) })
    return
  }
  if (configKey === 'waitAfterLoadedMs'
    || configKey === 'navigationTimeoutMs'
    || configKey === 'imageQuality'
    || configKey === 'viewportWidth'
    || configKey === 'viewportHeight'
    || configKey === 'deviceScaleFactor') {
    Object.assign(overrides, { [configKey]: parseFiniteNumber(value, optionName) })
    return
  }
  if (configKey === 'verboseFileLogRetention') {
    overrides.verboseFileLogRetention = parsePositiveInteger(value, optionName)
    return
  }
  if (configKey === 'cropRules') {
    overrides.cropRules = parseCropRules(value)
    return
  }
  if (configKey === 'waitUntil') {
    overrides.waitUntil = value as WaitUntil
    return
  }
  if (configKey === 'imageType') {
    overrides.imageType = value as ImageType
    return
  }
  if (configKey === 'trendScreenshotRange') {
    overrides.trendScreenshotRange = value as TrendScreenshotRange
    return
  }
  Object.assign(overrides, { [configKey]: value })
}

function parseCli(kind: ScreenshotKind, argv: string[]): ParsedCli {
  const options = readOptionTokens(argv)
  const take = (name: string) => {
    const value = options.get(name)
    options.delete(name)
    return value
  }
  const configPath = path.resolve(take('config') ?? DEFAULT_KOISHI_CONFIG)
  const outputDir = path.resolve(take('output') ?? DEFAULT_OUTPUT_DIR)
  const countValue = take('count')
  const intervalValue = take('interval-ms')
  const browserLaunchTimeoutValue = take('browser-launch-timeout-ms')
  const headlessValue = take('headless')
  const overrides: Partial<Config> = {}
  const configOptions = {
    ...COMMON_CONFIG_OPTIONS,
    ...(kind === 'status' ? STATUS_CONFIG_OPTIONS : TREND_CONFIG_OPTIONS),
  }

  for (const [optionName, configKey] of Object.entries(configOptions)) {
    const value = take(optionName)
    if (value !== undefined) {
      assignConfigOverride(overrides, configKey, optionName, value)
    }
  }

  const numValue = kind === 'trend' ? take('num') : undefined
  const unit = kind === 'trend' ? take('unit') : undefined
  const helpValue = take('help')
  const executablePath = take('executable-path')
  if (options.size) {
    throw new Error(`不支持的参数：${[...options.keys()].map(name => `--${name}`).join('、')}。`)
  }

  return {
    configPath,
    outputDir,
    count: countValue === undefined ? 5 : parsePositiveInteger(countValue, 'count'),
    intervalMs: intervalValue === undefined ? 2000 : parseFiniteNumber(intervalValue, 'interval-ms'),
    browserLaunchTimeoutMs: browserLaunchTimeoutValue === undefined
      ? 30000
      : parsePositiveInteger(browserLaunchTimeoutValue, 'browser-launch-timeout-ms'),
    executablePath: executablePath ? path.resolve(executablePath) : undefined,
    headless: headlessValue === undefined ? undefined : parseBoolean(headlessValue, 'headless'),
    configOverrides: overrides,
    trendNum: numValue === undefined ? undefined : parsePositiveInteger(numValue, 'num'),
    trendUnit: unit,
    help: helpValue === undefined ? false : parseBoolean(helpValue, 'help'),
  }
}

function findPluginConfig(
  plugins: PluginConfig,
  pluginName: string,
  includeDisabled = false,
): PluginConfig | undefined {
  for (const [key, value] of Object.entries(plugins ?? {})) {
    const disabled = key.startsWith('~')
    const normalizedName = key.replace(/^~/u, '').split(':', 1)[0]
    if (normalizedName === pluginName && (includeDisabled || !disabled)) {
      return value && typeof value === 'object' ? value as PluginConfig : {}
    }
    if (normalizedName === 'group' && value && typeof value === 'object') {
      const nested = findPluginConfig(value as PluginConfig, pluginName, includeDisabled)
      if (nested) return nested
    }
  }
}

async function loadKoishiConfig(configPath: string): Promise<{
  pluginConfig: Config
  puppeteerConfig: PluginConfig
}> {
  await access(configPath)
  const loader = new NodeLoader()
  await loader.init(configPath)

  // Loader normally rewrites writable YAML after reading it. Live tests are strictly read-only.
  loader.writable = false
  const rootConfig = await loader.readConfig()
  const plugins = (rootConfig.plugins ?? {}) as PluginConfig
  const rawPluginConfig = findPluginConfig(plugins, 'check-sub2api-status')
  if (!rawPluginConfig) {
    throw new Error(`在 ${configPath} 中找不到已启用的 check-sub2api-status 插件配置。`)
  }
  const puppeteerConfig = findPluginConfig(plugins, 'puppeteer')
    ?? findPluginConfig(plugins, 'puppeteer', true)
    ?? {}

  return {
    pluginConfig: rawPluginConfig as unknown as Config,
    puppeteerConfig,
  }
}

function resolveLaunchOptions(
  source: PluginConfig,
  cli: ParsedCli,
): PuppeteerLaunchOptions {
  const configuredExecutable = typeof source.executablePath === 'string'
    ? source.executablePath.trim()
    : ''
  const executablePath = cli.executablePath || configuredExecutable
  if (!executablePath) {
    throw new Error('Koishi Puppeteer 配置未提供 executablePath，请使用 --executable-path 指定 Chromium。')
  }

  return {
    executablePath,
    headless: cli.headless ?? (typeof source.headless === 'boolean' ? source.headless : true),
    timeout: cli.browserLaunchTimeoutMs,
    args: Array.isArray(source.args) ? source.args.map(String) : [],
    defaultViewport: source.defaultViewport && typeof source.defaultViewport === 'object'
      ? source.defaultViewport as PuppeteerLaunchOptions['defaultViewport']
      : undefined,
    ignoreHTTPSErrors: typeof source.ignoreHTTPSErrors === 'boolean'
      ? source.ignoreHTTPSErrors
      : undefined,
  }
}

function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function shouldAbortBatch(message: string): boolean {
  return /(?:登录态|authStateJson|Origin|User-Agent|refresh_token|HTTP\s+40[13]|返回\s+40[13])/iu.test(message)
}

function printHelp(kind: ScreenshotKind): void {
  const command = kind === 'status' ? 'test:live-status' : 'test:live-trend'
  const specific = kind === 'status'
    ? [
        '  --viewport-width <px>          覆盖 viewportWidth',
        '  --viewport-height <px>         覆盖 viewportHeight',
        '  --wait-for-selector <css>      覆盖 waitForSelector',
        '  --[no-]full-page               覆盖 fullPage',
        '  --crop-rules-json <json>       覆盖 cropRules',
      ]
    : [
        '  --num <int>                    趋势时间数量，默认沿用指令的 24',
        '  --unit <unit>                  h/hour/时/小时 或 d/day/天/日',
        '  --trend-screenshot-range <id>  all/charts-and-recent/recent-only',
      ]

  logHelp([
    `用法：npm run ${command} -- [options]`,
    '',
    '批次参数：',
    '  --config <path>                   Koishi 配置路径，默认 ../../koishi.yml',
    '  --output <dir>                    输出目录，默认 test/output',
    '  --count <int>                     截图次数，默认 5',
    '  --interval-ms <ms>                每轮完成后的间隔，默认 2000',
    '  --browser-launch-timeout-ms <ms>  Chromium 启动超时，默认 30000',
    '  --executable-path <path>           覆盖 Koishi Puppeteer 的 Chromium 路径',
    '  --[no-]headless                   覆盖 Chromium 无头模式',
    '',
    '通用截图覆盖：',
    '  --wait-until <mode>               domcontentloaded/load/networkidle0/networkidle2',
    '  --wait-after-loaded-ms <ms>       覆盖 waitAfterLoadedMs',
    '  --navigation-timeout-ms <ms>      覆盖 navigationTimeoutMs',
    '  --device-scale-factor <num>        覆盖两类截图共用的 deviceScaleFactor',
    '  --image-type <type>               png/jpeg/webp',
    '  --image-quality <1-100>            覆盖 imageQuality',
    '  --sub2api-base-url <url>           覆盖 sub2apiBaseUrl',
    '  --enable-auto-relogin <bool>       覆盖开关；账号密码仍只从 Koishi 配置读取',
    '  --enable-custom-user-agent <bool>  覆盖 enableCustomUserAgent',
    '  --custom-user-agent <text>         覆盖 customUserAgent',
    '  --verbose-console-log <bool>       覆盖 verboseConsoleLog',
    '  --verbose-file-log <bool>          覆盖 verboseFileLog',
    '  --verbose-file-log-retention <int> 覆盖 verboseFileLogRetention',
    '',
    `${kind === 'status' ? '状态页' : '趋势页'}覆盖：`,
    ...specific,
    '',
    '参数名也支持对应的 camelCase 写法，例如 --waitAfterLoadedMs。',
  ].join('\n'))
}

async function launchBrowser(source: PluginConfig, cli: ParsedCli): Promise<Browser> {
  const options = resolveLaunchOptions(source, cli)
  if (options.executablePath) await access(options.executablePath)
  return puppeteer.launch(options)
}

export async function runLiveScreenshotBatch(
  kind: ScreenshotKind,
  argv: string[],
): Promise<void> {
  const cli = parseCli(kind, argv)
  if (cli.help) {
    printHelp(kind)
    return
  }
  if (cli.intervalMs < 0) {
    throw new Error('--interval-ms 不能小于 0。')
  }

  const loaded = await loadKoishiConfig(cli.configPath)
  const config = ConfigSchema({
    ...loaded.pluginConfig,
    ...cli.configOverrides,
  })
  await mkdir(cli.outputDir, { recursive: true })

  logInfo('配置：', cli.configPath)
  logPath('输出：', cli.outputDir)
  logInfo(`批次：${kind} × ${cli.count}，轮次间隔 ${cli.intervalMs}ms`)
  logInfo(`覆盖字段：${Object.keys(cli.configOverrides).join(', ') || '(无)'}`)

  const browser = await launchBrowser(loaded.puppeteerConfig, cli)
  const ctx = {
    baseDir: path.dirname(cli.configPath),
    puppeteer: {
      page: () => browser.newPage(),
    },
  } as unknown as Context
  const results: BatchResult[] = []

  try {
    for (let index = 1; index <= cli.count; index += 1) {
      const startedAt = new Date()
      const startedMs = Date.now()
      const sequence = String(index).padStart(2, '0')
      const extension = config.imageType
      const filename = `${kind}-${formatTimestamp(startedAt)}-${sequence}.${extension}`
      const outputPath = path.join(cli.outputDir, filename)

      logStep(`[${index}/${cli.count}] 开始：`, outputPath)
      try {
        const image = kind === 'status'
          ? await captureStatusScreenshot(ctx, config)
          : await captureTrendScreenshot(ctx, config, cli.trendNum, cli.trendUnit)
        await writeFile(outputPath, image)
        const elapsedMs = Date.now() - startedMs
        results.push({ index, filename, elapsedMs })
        logSuccess(
          `[${index}/${cli.count}] 成功：`,
          `${outputPath} | ${image.length} bytes，${elapsedMs}ms`,
        )
      } catch (error) {
        const elapsedMs = Date.now() - startedMs
        const message = error instanceof Error ? error.message : String(error)
        results.push({ index, elapsedMs, error: message })
        logError(`[${index}/${cli.count}] 失败 ${elapsedMs}ms：`, message)
        if (shouldAbortBatch(message)) {
          logWarning('检测到认证或请求来源配置错误，停止剩余轮次。')
          break
        }
      }

      if (index < cli.count && cli.intervalMs > 0) {
        await sleep(cli.intervalMs)
      }
    }
  } finally {
    await browser.close().catch(() => undefined)
  }

  const succeeded = results.filter(result => !result.error).length
  const failed = results.length - succeeded
  logSummary(
    `完成：尝试 ${results.length}/${cli.count}，成功 ${succeeded}，失败 ${failed}。`,
    failed === 0,
  )
  if (failed) {
    throw new Error(`${kind} 批量截图存在 ${failed} 次失败。`)
  }
}
