import { Schema } from 'koishi'

import { CROP_DIRECTIONS, TREND_SCREENSHOT_RANGES } from './types'
import type { CropRule, ImageType, TrendScreenshotRange, WaitUntil } from './types'

export interface Config {
  // ===== 📋 指令设置 =====
  enableStatusCommand: boolean
  statusCommandName: string
  enableTrendCommand: boolean
  trendCommandName: string

  // ===== 💬 消息设置 =====
  enableQuote: boolean
  enableWaitingHint: boolean

  // ===== 🚇 中转站设置 =====
  sub2apiBaseUrl: string
  authStateJson: string
  enableCustomUserAgent: boolean
  customUserAgent: string
  enableAutoRelogin: boolean
  loginEmail: string
  loginPassword: string

  // ===== 🌐 通用截图设置 =====
  waitUntil: WaitUntil
  waitAfterLoadedMs: number
  navigationTimeoutMs: number
  deviceScaleFactor: number
  imageType: ImageType
  imageQuality: number

  // ===== 📡 状态页截图设置 =====
  viewportWidth: number
  viewportHeight: number
  waitForSelector: string
  fullPage: boolean
  cropRules: CropRule[]

  // ===== 📈 趋势截图设置 =====
  trendScreenshotRange: TrendScreenshotRange

  // ===== 🐛 调试设置 =====
  verboseLog: boolean
}

export const Config: Schema<Config> = Schema.intersect([
  // ===== 📋 指令设置 =====
  Schema.object({
    enableStatusCommand: Schema.boolean()
      .default(true)
      .description('📡 是否启用 sub2api 渠道状态截图指令。'),
    statusCommandName: Schema.string()
      .default('sub2api-status')
      .description('⌨️ sub2api 渠道状态截图指令名称。'),
    enableTrendCommand: Schema.boolean()
      .default(false)
      .description('📈 是否启用 sub2api 管理仪表盘趋势截图指令。'),
    trendCommandName: Schema.string()
      .default('sub2api-trend')
      .description('⌨️ sub2api 管理仪表盘趋势截图指令名称。'),
  }).description('📋 指令设置'),

  // ===== 💬 消息设置 =====
  Schema.object({
    enableQuote: Schema.boolean()
      .default(true)
      .description('💬 回复图片时引用触发消息'),
    enableWaitingHint: Schema.boolean()
      .default(true)
      .description('⏳ 是否显示“正在截图，请稍候...”的等待提示'),
  }).description('💬 消息设置'),

  // ===== 🚇 中转站设置 =====
  Schema.object({
    sub2apiBaseUrl: Schema.string()
      .role('link')
      .default('http://127.0.0.1:8080')
      .description('🔗 sub2api 服务根地址，不包含 /monitor 或 /admin/dashboard 页面路径。'),
    authStateJson: Schema.string()
      .role('textarea', { rows: [4, 10] })
      .default('')
      .description('🔐 登录态 JSON，包含 Origin、User-Agent 和 localStorage。请用 `tools/export-auth-state.py` 或 `.mjs` 导出后，把完整 JSON 粘贴到这里。'),
    enableCustomUserAgent: Schema.boolean()
      .default(false)
      .description('🧪 是否使用自定义 User-Agent 覆盖登录态 JSON 中导出的 User-Agent。'),
    customUserAgent: Schema.string()
      .default('')
      .description('🏷️ 自定义 User-Agent，仅在启用自定义 User-Agent 时生效。'),
    enableAutoRelogin: Schema.boolean()
      .default(false)
      .description('🔄🔐 登录态刷新失效后，是否使用配置的账号密码自动重新登录；启用前请先阅读 README 中的 sub2api 安全配置要求。'),
    loginEmail: Schema.string()
      .default('')
      .description('📧🔐 sub2api 本地管理员登录邮箱，仅在启用自动刷新与重新登录时使用。'),
    loginPassword: Schema.string()
      .role('secret')
      .default('')
      .description('🔑🛡️ sub2api 本地管理员登录密码；控制台仅遮罩显示，配置文件中的值不会被加密。'),
  }).description('🚇 中转站设置'),

  // ===== 🌐 通用截图设置 =====
  Schema.object({
    waitUntil: Schema.union([
      Schema.const('domcontentloaded').description('⚡【domcontentloaded】DOM 加载完成'),
      Schema.const('load').description('✅【load】 load 事件完成'),
      Schema.const('networkidle0').description('🌐【networkidle0】 网络完全空闲'),
      Schema.const('networkidle2').description('📡【networkidle2】 网络基本空闲'),
    ]).role('radio').default('domcontentloaded').description('⏳🌐 两类截图共用的页面导航等待策略'),
    waitAfterLoadedMs: Schema.number()
      .role('')
      .min(0)
      .max(10000)
      .step(1)
      .default(5555)
      .description('⏱️🎨 两类截图共用的页面加载后额外等待时间'),
    navigationTimeoutMs: Schema.number()
      .min(5000)
      .max(120000)
      .step(1000)
      .default(45000)
      .description('⌛🌐 两类截图共用的页面导航与接口等待超时时间'),
    deviceScaleFactor: Schema.number()
      .min(0.1)
      .max(10)
      .step(0.1)
      .default(2.5)
      .description('🔎🖼️ 两类截图共用的设备缩放倍率；数值越高，输出分辨率与内存占用越高'),
    imageType: Schema.union([
      Schema.const('png').description('🖼️ PNG'),
      Schema.const('jpeg').description('🌄 JPEG'),
      Schema.const('webp').description('🌐 WebP'),
    ]).role('radio').default('png').description('📤🖼️ 两类截图共用的输出图片格式'),
    imageQuality: Schema.number()
      .role('slider')
      .min(1)
      .max(100)
      .step(1)
      .default(86)
      .description('🎚️🖼️ JPEG/WebP 图片质量，PNG 会忽略此配置'),
  }).description('🌐 通用截图设置'),

  // ===== 📡 状态页截图设置 =====
  Schema.object({
    viewportWidth: Schema.number()
      .min(100)
      .max(10000)
      .step(1)
      .default(999)
      .description('📡↔️ 状态页浏览器视口宽度'),
    viewportHeight: Schema.number()
      .min(100)
      .max(10000)
      .step(1)
      .default(999)
      .description('📡↕️ 状态页浏览器视口高度'),
    waitForSelector: Schema.string()
      .default('body')
      .description('📡🎯 状态页截图前等待的 CSS 选择器，默认 body'),
    fullPage: Schema.boolean()
      .default(true)
      .description('📡🧾 状态页无裁剪规则时是否截取完整页面'),
    cropRules: Schema.array(Schema.object({
      direction: Schema.union([
        Schema.const(CROP_DIRECTIONS.TOP).description('⬆️ 上'),
        Schema.const(CROP_DIRECTIONS.RIGHT).description('➡️ 右'),
        Schema.const(CROP_DIRECTIONS.BOTTOM).description('⬇️ 下'),
        Schema.const(CROP_DIRECTIONS.LEFT).description('⬅️ 左'),
      ]).role('radio').description('🧭 裁剪方向'),
      pixels: Schema.number()
        .min(0)
        .max(2000)
        .step(1)
        .default(50)
        .description('✂️ 裁剪像素'),
      enabled: Schema.boolean()
        .default(true)
        .description('✅ 是否启用'),
    }))
      .role('table')
      .default([
        { direction: CROP_DIRECTIONS.TOP, pixels: 67, enabled: true },
        { direction: CROP_DIRECTIONS.RIGHT, pixels: 288, enabled: true },
        { direction: CROP_DIRECTIONS.BOTTOM, pixels: 456, enabled: true },
        { direction: CROP_DIRECTIONS.LEFT, pixels: 20, enabled: true },
      ])
      .description('📡✂️ 状态页裁剪规则；重复方向只使用靠前的第一条已启用规则'),
  }).description('📡 状态页截图设置'),

  // ===== 📈 趋势截图设置 =====
  Schema.object({
    trendScreenshotRange: Schema.union([
      Schema.const(TREND_SCREENSHOT_RANGES.ALL)
        .description('🧩 完整趋势区域（A + B + C）'),
      Schema.const(TREND_SCREENSHOT_RANGES.CHARTS_AND_RECENT)
        .description('📊 图表与最近使用（B + C）'),
      Schema.const(TREND_SCREENSHOT_RANGES.RECENT_ONLY)
        .description('📉 仅最近使用（C）'),
    ])
      .role('radio')
      .default(TREND_SCREENSHOT_RANGES.ALL)
      .description('📐🖥️ 趋势截图范围；视口固定为 2240×1200，缩放倍率使用通用截图设置。<br>`A 为时间范围`<br>`B 为模型分布与 Token 使用趋势`<br>`C 为最近使用`'),
  }).description('📈 趋势截图设置'),

  // ===== 🐛 调试设置 =====
  Schema.object({
    verboseLog: Schema.boolean()
      .default(false)
      .description('🐛 输出更详细的插件日志'),
  }).description('🐛 调试设置'),
]) as unknown as Schema<Config>
