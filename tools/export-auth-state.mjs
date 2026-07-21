#!/usr/bin/env node
/*
 * 用法示例（Node 版，需要项目依赖里的 puppeteer-core）:
 *
 *   node tools/export-auth-state.mjs --browser "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
 *
 * 参数及默认值:
 *   --browser  默认依次读取 CHROME_PATH、PUPPETEER_EXECUTABLE_PATH；均未设置时必须传入
 *   --url      默认 "http://127.0.0.1:8080/monitor"
 *   --profile  默认 "data/sub2api-auth-profile-js"（相对于当前工作目录）
 *   --out      默认 "tools/output/sub2api-auth-state-YYYYMMDD-HHMMSS.json"（相对于脚本目录）
 *   --timeout  默认 600000 毫秒（10 分钟）
 *   --profile-mode 默认 "temporary"，可选 temporary/reuse/reset/open
 *
 * 脚本会打开一个独立浏览器窗口；如果没登录，就在窗口里登录 sub2api。
 * 识别到 localStorage 里的 auth_token + auth_user 后，会连同 Origin 和 User-Agent
 * 导出 Koishi 插件可直接读取的 JSON。
 */

import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const STORAGE_KEYS = [
  'auth_token',
  'refresh_token',
  'auth_user',
  'token_expires_at',
]

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output')
const DEFAULT_PROFILE_DIR = path.resolve(process.cwd(), 'data/sub2api-auth-profile-js')
const PROFILE_MARKER_NAME = '.sub2api-auth-profile'
const PROFILE_MODES = new Set(['temporary', 'reuse', 'reset', 'open'])
const ANSI_ENABLED = !process.env.NO_COLOR
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
}

function style(text, ...codes) {
  if (!ANSI_ENABLED || !codes.length) return String(text)
  return `${codes.join('')}${text}${ANSI.reset}`
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function formatLocalTime(date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

function formatLocalFromMs(value) {
  const timestampMs = Number(value)
  if (!Number.isFinite(timestampMs)) return '未知'
  return formatLocalTime(new Date(timestampMs))
}

function formatLocalFromIso(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未知'
  return formatLocalTime(date)
}

function formatRemaining(value) {
  const timestampMs = Number(value)
  if (!Number.isFinite(timestampMs)) return '未知'

  let remainingSeconds = Math.floor((timestampMs - Date.now()) / 1000)
  if (remainingSeconds <= 0) return '已过期'

  const days = Math.floor(remainingSeconds / 86400)
  remainingSeconds %= 86400
  const hours = Math.floor(remainingSeconds / 3600)
  remainingSeconds %= 3600
  const minutes = Math.floor(remainingSeconds / 60)
  const seconds = remainingSeconds % 60

  const parts = []
  if (days) parts.push(`${days}天`)
  if (hours || parts.length) parts.push(`${hours}小时`)
  if (minutes || parts.length) parts.push(`${minutes}分钟`)
  parts.push(`${seconds}秒`)
  return parts.join('')
}

function printSummary(output, outPath) {
  const expiresAt = output.localStorage?.token_expires_at
  console.log()
  console.log(style('════════════════════════════════════════', ANSI.cyan))
  console.log(style('✅ 登录态导出成功', ANSI.bold, ANSI.green))
  console.log(style('════════════════════════════════════════', ANSI.cyan))
  console.log(style('🧩 Koishi 配置填写提示', ANSI.bold, ANSI.magenta))
  console.log(style(`   🔗 sub2apiBaseUrl: ${output.origin || '未知'}`, ANSI.bold, ANSI.cyan))
  console.log(style('   🔐 authStateJson: 复制下方完整 JSON', ANSI.bold, ANSI.cyan))
  console.log()
  console.log(style('⏰ Token 过期信息', ANSI.bold, ANSI.yellow))
  console.log(style(`   原始 token_expires_at: ${expiresAt || '未知'}`, ANSI.yellow))
  console.log(style(`   人类可读过期时间: ${formatLocalFromMs(expiresAt)}`, ANSI.bold, ANSI.yellow))
  console.log(style(`   当前剩余时间: ${formatRemaining(expiresAt)}`, ANSI.bold, ANSI.yellow))
  console.log()
  console.log(style('📦 导出信息', ANSI.bold, ANSI.green))
  console.log(style(`   🌐 页面 Origin: ${output.origin || '未知'}`, ANSI.green))
  console.log(style(`   🏷️ 浏览器 UA: ${output.userAgent || '未知'}`, ANSI.green))
  console.log(style(`   🕒 导出时间: ${formatLocalFromIso(output.exported_at)}`, ANSI.green))
  console.log(style(`   💾 文件位置: ${outPath}`, ANSI.green))
  console.log(style('════════════════════════════════════════', ANSI.cyan))
  console.log(style('📋 下方 JSON 可直接粘贴到 Koishi 的 authStateJson 配置项。', ANSI.bold, ANSI.magenta))
  console.log()
}

function fileTimestamp() {
  const now = new Date()
  return [
    now.getFullYear(),
    pad2(now.getMonth() + 1),
    pad2(now.getDate()),
  ].join('') + '-' + [
    pad2(now.getHours()),
    pad2(now.getMinutes()),
    pad2(now.getSeconds()),
  ].join('')
}

function defaultOutPath() {
  return path.join(OUTPUT_DIR, `sub2api-auth-state-${fileTimestamp()}.json`)
}

function utcNowIsoSeconds() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function parseArgs(argv) {
  const args = {
    url: 'http://127.0.0.1:8080/monitor',
    profile: DEFAULT_PROFILE_DIR,
    out: defaultOutPath(),
    browser: process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '',
    timeout: 10 * 60 * 1000,
    profileMode: 'temporary',
  }

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const value = argv[i + 1]
    switch (key) {
      case '--browser':
      case '-b':
        args.browser = value
        i += 1
        break
      case '--url':
      case '-u':
        args.url = value
        i += 1
        break
      case '--profile':
      case '-p':
        args.profile = path.resolve(value)
        i += 1
        break
      case '--out':
      case '-o':
        args.out = path.resolve(value)
        i += 1
        break
      case '--timeout':
        args.timeout = Number(value)
        i += 1
        break
      case '--profile-mode':
        args.profileMode = value
        i += 1
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
      default:
        throw new Error(`❓ Unknown argument: ${key}`)
    }
  }

  if (!args.browser) {
    throw new Error('🌐 Missing --browser. Example: --browser "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"')
  }
  if (!PROFILE_MODES.has(args.profileMode)) {
    throw new Error(`❓ Invalid --profile-mode: ${args.profileMode}. Expected: ${Array.from(PROFILE_MODES).join(', ')}`)
  }

  return args
}

function printHelp() {
  console.log(`
Usage:
  node tools/export-auth-state.mjs --browser "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"

Options:
  -b, --browser   Chrome/Chromium executable path. Required.
  -u, --url       sub2api monitor URL. Default: http://127.0.0.1:8080/monitor
  -p, --profile   Dedicated browser profile dir. Default: ./data/sub2api-auth-profile-js
  --profile-mode  Profile lifecycle: temporary, reuse, reset, or open. Default: temporary
  -o, --out       Output auth JSON path. Default: tools/output/sub2api-auth-state-YYYYMMDD-HHMMSS.json
  --timeout       Wait timeout in ms. Default: 600000
`)
}

function normalizeComparePath(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isSameOrParentPath(candidate, target) {
  const relative = path.relative(candidate, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function getPathStats(value) {
  try {
    return await lstat(value)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function validateProfilePath(profilePath) {
  const normalized = normalizeComparePath(profilePath)
  if (normalized === normalizeComparePath(path.parse(normalized).root)) {
    throw new Error(`🛑 Refusing to manage filesystem root as profile path: ${profilePath}`)
  }

  const protectedPaths = [
    normalizeComparePath(process.cwd()),
    normalizeComparePath(os.homedir()),
    normalizeComparePath(SCRIPT_DIR),
  ]
  if (protectedPaths.some(protectedPath => isSameOrParentPath(normalized, protectedPath))) {
    throw new Error(`🛑 Refusing to manage unsafe profile path: ${profilePath}`)
  }

  const stats = await getPathStats(profilePath)
  if (!stats) return null
  if (stats.isSymbolicLink()) {
    throw new Error(`🛑 Refusing to manage linked profile path: ${profilePath}`)
  }
  if (!stats.isDirectory()) {
    throw new Error(`🛑 Profile path exists but is not a directory: ${profilePath}`)
  }
  return stats
}

async function profileIsScriptOwned(profilePath) {
  if (normalizeComparePath(profilePath) === normalizeComparePath(DEFAULT_PROFILE_DIR)) {
    return true
  }
  const markerStats = await getPathStats(path.join(profilePath, PROFILE_MARKER_NAME))
  return Boolean(markerStats?.isFile())
}

async function clearProfile(profilePath) {
  const stats = await validateProfilePath(profilePath)
  if (!stats) return
  if (!await profileIsScriptOwned(profilePath)) {
    throw new Error(`🛑 Refusing to delete unmarked profile directory: ${profilePath}. Missing ${PROFILE_MARKER_NAME}.`)
  }

  try {
    await rm(profilePath, {
      recursive: true,
      force: false,
      maxRetries: 10,
      retryDelay: 100,
    })
  } catch (error) {
    throw new Error(`🧹 Failed to delete profile directory ${profilePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (await getPathStats(profilePath)) {
    throw new Error(`🧹 Profile directory still exists after cleanup: ${profilePath}`)
  }
}

async function prepareProfile(profilePath, profileMode) {
  await validateProfilePath(profilePath)
  if (profileMode === 'temporary' || profileMode === 'reset') {
    await clearProfile(profilePath)
  }

  const existed = Boolean(await getPathStats(profilePath))
  await mkdir(profilePath, { recursive: true })
  const markerPath = path.join(profilePath, PROFILE_MARKER_NAME)
  if (!existed || await profileIsScriptOwned(profilePath)) {
    await writeFile(markerPath, 'sub2api auth profile\n', 'utf8')
  } else {
    console.warn(style(`⚠️ [sub2api-auth] Reusing unmarked custom profile; it will never be deleted automatically: ${profilePath}`, ANSI.yellow))
  }
}

function normalizeAuthUser(value) {
  if (typeof value === 'string' && value.trim()) return value
  return JSON.stringify({
    id: 0,
    email: 'bot@local',
    username: 'bot',
    role: 'user',
    status: 'active',
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const origin = new URL(args.url).origin
  let browser
  let profilePrepared = false

  try {
    await prepareProfile(args.profile, args.profileMode)
    profilePrepared = true
    browser = await puppeteer.launch({
      executablePath: args.browser,
      headless: false,
      userDataDir: args.profile,
      defaultViewport: {
        width: 1440,
        height: 1100,
        deviceScaleFactor: 1,
      },
      args: [
        '--no-first-run',
        '--disable-features=Translate',
      ],
    })

    const page = await browser.newPage()
    await page.goto(args.url, { waitUntil: 'domcontentloaded' })

    console.log(style(`🌐 [sub2api-auth] Opened ${args.url}`, ANSI.cyan))
    console.log(style('🔐 [sub2api-auth] Log in in the opened browser window if needed.', ANSI.yellow))
    console.log(style('⏳ [sub2api-auth] Waiting for localStorage auth_token + auth_user ...', ANSI.yellow))

    await page.waitForFunction(() => {
      return Boolean(localStorage.getItem('auth_token') && localStorage.getItem('auth_user'))
    }, { timeout: args.timeout })

    const localStorageState = await page.evaluate((keys) => {
      const result = {}
      for (const key of keys) {
        const value = localStorage.getItem(key)
        if (value !== null) result[key] = value
      }
      return result
    }, STORAGE_KEYS)
    const userAgent = await page.evaluate(() => navigator.userAgent)
    if (typeof userAgent !== 'string' || !userAgent.trim()) {
      throw new Error('🏷️ Auth state payload did not contain navigator.userAgent')
    }

    localStorageState.auth_user = normalizeAuthUser(localStorageState.auth_user)
    if (!localStorageState.token_expires_at) {
      localStorageState.token_expires_at = String(Date.now() + 24 * 60 * 60 * 1000)
    }

    const output = {
      origin,
      userAgent: userAgent.trim(),
      exported_at: utcNowIsoSeconds(),
      localStorage: localStorageState,
    }

    const outputJson = JSON.stringify(output, null, 2)
    await mkdir(path.dirname(args.out), { recursive: true })
    await writeFile(args.out, `${outputJson}\n`, 'utf8')
    printSummary(output, args.out)
    console.log(style('📦 [sub2api-auth] JSON:', ANSI.bold, ANSI.magenta))
    console.log(outputJson)

    if (args.profileMode === 'open') {
      console.log(style('🪟 [sub2api-auth] profile mode is open; press Ctrl+C to exit when done.', ANSI.yellow))
      await new Promise(() => {})
    }
  } finally {
    try {
      if (args.profileMode !== 'open' && browser) {
        await browser.close()
      }
    } finally {
      if (args.profileMode === 'temporary' && profilePrepared) {
        await clearProfile(args.profile)
        console.log(style(`🧹 [sub2api-auth] Removed temporary profile: ${args.profile}`, ANSI.cyan))
      }
    }
  }
}

main().catch((error) => {
  console.error(style(`❌ [sub2api-auth] ${error instanceof Error ? error.message : String(error)}`, ANSI.red))
  process.exit(1)
})
