import { Schema } from 'koishi'

import { CROP_DIRECTIONS } from './types'
import type { CropRule, ImageType, WaitUntil } from './types'

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
  monitorUrl: string
  authStateJson: string

  // ===== 📸 截图设置 =====
  viewportWidth: number
  viewportHeight: number
  deviceScaleFactor: number
  waitUntil: WaitUntil
  waitForSelector: string
  waitAfterLoadedMs: number
  navigationTimeoutMs: number
  fullPage: boolean
  cropRules: CropRule[]
  imageType: ImageType
  imageQuality: number

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
      .description('📈 是否启用 sub2api 最近使用趋势截图指令。'),
    trendCommandName: Schema.string()
      .default('trend')
      .description('⌨️ sub2api 最近使用趋势截图指令名称。'),
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
    monitorUrl: Schema.string()
      .role('link')
      .default('http://127.0.0.1:8080/monitor')
      .description('🔗 sub2api 渠道状态页面地址'),
    authStateJson: Schema.string()
      .role('textarea', { rows: [4, 10] })
      .default('')
      .description('🔐 登录态 JSON。请用 tools/export-auth-state.py 或 .mjs 导出后，把控制台输出的 JSON 粘贴到这里。'),
  }).description('🚇 中转站设置'),

  // ===== 📸 截图设置 =====
  Schema.object({
    viewportWidth: Schema.number()
      .min(100)
      .max(10000)
      .step(1)
      .default(999)
      .description('↔️ 浏览器视口宽度'),
    viewportHeight: Schema.number()
      .min(100)
      .max(10000)
      .step(1)
      .default(999)
      .description('↕️ 浏览器视口高度'),
    deviceScaleFactor: Schema.number()
      .min(0.1)
      .max(10)
      .step(0.1)
      .default(3.3)
      .description('🔎 设备缩放倍率'),
    waitUntil: Schema.union([
      Schema.const('domcontentloaded').description('⚡ DOM 加载完成'),
      Schema.const('load').description('✅ load 事件完成'),
      Schema.const('networkidle0').description('🌐 网络完全空闲'),
      Schema.const('networkidle2').description('📡 网络基本空闲'),
    ]).role('radio').default('domcontentloaded').description('⏳ 页面导航等待策略'),
    waitForSelector: Schema.string()
      .default('body')
      .description('🎯 截图前等待出现的 CSS 选择器。默认 body；如果页面结构稳定，可以改成更具体的选择器。'),
    waitAfterLoadedMs: Schema.number()
      .role('slider')
      .min(0)
      .max(10000)
      .step(100)
      .default(1800)
      .description('⏱️ 页面加载后额外等待时间，用来等 Vue 渲染和接口返回'),
    navigationTimeoutMs: Schema.number()
      .min(5000)
      .max(120000)
      .step(1000)
      .default(45000)
      .description('⌛ 页面打开超时时间'),
    fullPage: Schema.boolean()
      .default(true)
      .description('🧾 是否截取完整页面'),
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
        { direction: CROP_DIRECTIONS.RIGHT, pixels: 20, enabled: true },
        { direction: CROP_DIRECTIONS.BOTTOM, pixels: 456, enabled: true },
        { direction: CROP_DIRECTIONS.LEFT, pixels: 20, enabled: true },
      ])
      .description('✂️ 截图裁剪规则。每行选择一个方向、填写像素数量，并决定是否启用。若出现重复方向，只会使用表格中靠前的第一条已启用规则。'),
    imageType: Schema.union([
      Schema.const('png').description('🖼️ PNG'),
      Schema.const('jpeg').description('🌄 JPEG'),
      Schema.const('webp').description('🌐 WEBP'),
    ]).role('radio').default('png').description('📤 输出图片格式'),
    imageQuality: Schema.number()
      .role('slider')
      .min(1)
      .max(100)
      .step(1)
      .default(86)
      .description('🎚️ JPEG/WEBP 图片质量'),
  }).description('📸 截图设置'),

  // ===== 🐛 调试设置 =====
  Schema.object({
    verboseLog: Schema.boolean()
      .default(false)
      .description('🐛 输出更详细的插件日志'),
  }).description('🐛 调试设置'),
]) as unknown as Schema<Config>
