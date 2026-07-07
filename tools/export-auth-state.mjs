#!/usr/bin/env node
/*
 * 用法示例（Node 版，需要项目依赖里的 puppeteer-core）:
 *
 *   node tools/export-auth-state.mjs --browser "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
 *
 * 常用参数:
 *   --url "http://127.0.0.1:8080/monitor"
 *   --out "tools/output/sub2api-auth-state-YYYYMMDD-HHMMSS.json"
 *   --profile "data/sub2api-auth-profile"
 *   --keep-open
 *
 * 脚本会打开一个独立浏览器窗口；如果没登录，就在窗口里登录 sub2api。
 * 识别到 localStorage 里的 auth_token + auth_user 后，会导出 Koishi 插件可直接读取的 JSON。
 */

import { mkdir, writeFile } from 'node:fs/promises'
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

function printSummary(output, outPath, monitorUrl) {
  const expiresAt = output.localStorage?.token_expires_at
  console.log()
  console.log(style('════════════════════════════════════════', ANSI.cyan))
  console.log(style('✅ 登录态导出成功', ANSI.bold, ANSI.green))
  console.log(style('════════════════════════════════════════', ANSI.cyan))
  console.log(style('🧩 Koishi 配置填写提示', ANSI.bold, ANSI.magenta))
  console.log(style(`   🔗 monitorUrl: ${monitorUrl}`, ANSI.bold, ANSI.cyan))
  console.log(style('   🔐 authStateJson: 复制下方完整 JSON', ANSI.bold, ANSI.cyan))
  console.log()
  console.log(style('⏰ Token 过期信息', ANSI.bold, ANSI.yellow))
  console.log(style(`   原始 token_expires_at: ${expiresAt || '未知'}`, ANSI.yellow))
  console.log(style(`   人类可读过期时间: ${formatLocalFromMs(expiresAt)}`, ANSI.bold, ANSI.yellow))
  console.log(style(`   当前剩余时间: ${formatRemaining(expiresAt)}`, ANSI.bold, ANSI.yellow))
  console.log()
  console.log(style('📦 导出信息', ANSI.bold, ANSI.green))
  console.log(style(`   🌐 页面 Origin: ${output.origin || '未知'}`, ANSI.green))
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
    profile: path.resolve(process.cwd(), 'data/sub2api-auth-profile'),
    out: defaultOutPath(),
    browser: process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '',
    timeout: 10 * 60 * 1000,
    keepOpen: false,
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
      case '--keep-open':
        args.keepOpen = true
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

  return args
}

function printHelp() {
  console.log(`
Usage:
  node tools/export-auth-state.mjs --browser "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"

Options:
  -b, --browser   Chrome/Chromium executable path. Required.
  -u, --url       sub2api monitor URL. Default: http://127.0.0.1:8080/monitor
  -p, --profile   Dedicated browser profile dir. Default: ./data/sub2api-auth-profile
  -o, --out       Output auth JSON path. Default: tools/output/sub2api-auth-state-YYYYMMDD-HHMMSS.json
  --timeout       Wait timeout in ms. Default: 600000
  --keep-open     Do not close the browser after export.
`)
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

  await mkdir(args.profile, { recursive: true })

  const browser = await puppeteer.launch({
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

  try {
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

    localStorageState.auth_user = normalizeAuthUser(localStorageState.auth_user)
    if (!localStorageState.token_expires_at) {
      localStorageState.token_expires_at = String(Date.now() + 24 * 60 * 60 * 1000)
    }

    const output = {
      origin,
      exported_at: utcNowIsoSeconds(),
      localStorage: localStorageState,
    }

    const outputJson = JSON.stringify(output, null, 2)
    await mkdir(path.dirname(args.out), { recursive: true })
    await writeFile(args.out, `${outputJson}\n`, 'utf8')
    printSummary(output, args.out, args.url)
    console.log(style('📦 [sub2api-auth] JSON:', ANSI.bold, ANSI.magenta))
    console.log(outputJson)

    if (args.keepOpen) {
      console.log(style('🪟 [sub2api-auth] --keep-open enabled; press Ctrl+C to exit when done.', ANSI.yellow))
      await new Promise(() => {})
    }
  } finally {
    if (!args.keepOpen) {
      await browser.close()
    }
  }
}

main().catch((error) => {
  console.error(style(`❌ [sub2api-auth] ${error instanceof Error ? error.message : String(error)}`, ANSI.red))
  process.exit(1)
})
