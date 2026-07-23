import { randomUUID } from 'node:crypto'
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import type { Context, Logger } from 'koishi'
import type { Page } from 'puppeteer-core'

import {
  type Config,
  VERBOSE_FILE_LOG_PATH_RELATIVE_TO_BASE_DIR,
} from './config'
import type { ImageType } from './types'

export type CaptureKind = 'status' | 'trend'
export type DiagnosticDetails = Record<string, unknown>

export interface DiagnosticSink {
  event(phase: string, message: string, details?: DiagnosticDetails): void
}

interface DiagnosticEvent {
  at: string
  elapsedMs: number
  attempt: number
  phase: string
  message: string
  details?: DiagnosticDetails
}

interface DiagnosticError {
  name: string
  message: string
  stack?: string
}

interface DiagnosticPayload {
  schemaVersion: 1
  captureId: string
  kind: CaptureKind
  result: 'success' | 'failure'
  attempt: number
  startedAt: string
  finishedAt: string
  durationMs: number
  recoveredByRetry: boolean
  previousAttemptFailed: boolean
  config: DiagnosticDetails
  details: DiagnosticDetails
  error?: DiagnosticError
  artifacts: {
    imageCaptured: boolean
    imageFormat?: ImageType
    historyImage?: string
    latestImage?: string
  }
  events: DiagnosticEvent[]
}

interface PersistedFailure {
  payload: DiagnosticPayload
  historyJsonPath: string
  latestJsonPath: string
  lockKey: string
}

const IMAGE_TYPES: ImageType[] = ['png', 'jpeg', 'webp']
const fileWriteLocks = new Map<string, Promise<void>>()

function shouldWriteConsoleEvent(phase: string): boolean {
  return phase === 'trend.range.resolved'
    || phase === 'page.navigate.ok'
    || phase === 'page.selector.ok'
    || phase === 'screenshot.crop'
    || phase === 'screenshot.clip'
    || phase === 'auth.check'
    || phase.startsWith('capture.')
    || phase.startsWith('auth.refresh.')
    || phase.startsWith('auth.relogin.')
    || (phase.startsWith('api.') && !phase.endsWith('.start'))
    || phase.startsWith('canvas.')
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[^\s"']+/giu, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[JWT REDACTED]')
    .replace(/\brt_[A-Za-z0-9_-]{8,}\b/gu, '[REFRESH TOKEN REDACTED]')
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[MAX DEPTH]'
  if (typeof value === 'string') return redactSensitiveText(value)
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Error) return serializeError(value)
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeValue(item, depth + 1)]),
    )
  }
  return value
}

function sanitizeDetails(details: DiagnosticDetails): DiagnosticDetails {
  return sanitizeValue(details) as DiagnosticDetails
}

function omitConsoleStacks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitConsoleStacks)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'stack')
        .map(([key, item]) => [key, omitConsoleStacks(item)]),
    )
  }
  return value
}

function serializeError(error: unknown): DiagnosticError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactSensitiveText(error.message),
      ...(error.stack ? { stack: redactSensitiveText(error.stack) } : {}),
    }
  }
  return {
    name: 'Error',
    message: redactSensitiveText(String(error)),
  }
}

function formatFileTimestamp(date: Date): string {
  return date.toISOString()
    .replace(/[-:]/gu, '')
    .replace('T', '-')
    .replace('Z', '')
    .replace('.', '-')
}

function safeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function withFileWriteLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = fileWriteLocks.get(key) ?? Promise.resolve()
  const current = previous.then(task, task)
  fileWriteLocks.set(key, current.then(() => undefined, () => undefined))
  return current
}

async function removeOtherLatestImages(
  kindDir: string,
  result: 'success' | 'failure',
  keepType: ImageType,
): Promise<void> {
  await Promise.all(IMAGE_TYPES
    .filter(type => type !== keepType)
    .map(type => rm(path.join(kindDir, `latest-${result}.${type}`), { force: true })))
}

async function pruneHistory(directory: string, retention: number): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const jsonFiles = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => entry.name)
    .sort((left, right) => right.localeCompare(left))

  await Promise.all(jsonFiles.slice(retention).flatMap((jsonName) => {
    const basename = jsonName.slice(0, -'.json'.length)
    return [
      rm(path.join(directory, jsonName), { force: true }),
      ...IMAGE_TYPES.map(type => rm(path.join(directory, `${basename}.${type}`), { force: true })),
    ]
  }))
}

function fallbackLogger(): Pick<Logger, 'info' | 'warn'> {
  return {
    info: (...args: unknown[]) => console.info(...args),
    warn: (...args: unknown[]) => console.warn(...args),
  } as Pick<Logger, 'info' | 'warn'>
}

export class CaptureDiagnostics implements DiagnosticSink {
  readonly captureId = randomUUID().slice(0, 8)
  readonly startedAt = new Date()

  private readonly startedMs = Date.now()
  private readonly consoleEnabled: boolean
  private readonly fileEnabled: boolean
  private readonly retention: number
  private readonly logger: Pick<Logger, 'info' | 'warn'>
  private readonly kindDir: string
  private readonly events: DiagnosticEvent[] = []
  private attempt = 0
  private lastFailure?: PersistedFailure

  constructor(
    ctx: Context,
    private readonly kind: CaptureKind,
    config: Pick<Config, 'verboseConsoleLog' | 'verboseFileLog' | 'verboseFileLogRetention'>,
    private readonly configSnapshot: DiagnosticDetails,
  ) {
    this.consoleEnabled = Boolean(config.verboseConsoleLog)
    this.fileEnabled = Boolean(config.verboseFileLog)
    const requestedRetention = Number(config.verboseFileLogRetention)
    this.retention = Number.isSafeInteger(requestedRetention)
      ? Math.max(1, Math.min(100, requestedRetention))
      : 10
    this.logger = typeof ctx.logger === 'function'
      ? ctx.logger('check-sub2api-status')
      : fallbackLogger()
    const baseDir = typeof ctx.baseDir === 'string' && ctx.baseDir
      ? ctx.baseDir
      : process.cwd()
    this.kindDir = path.join(
      baseDir,
      ...VERBOSE_FILE_LOG_PATH_RELATIVE_TO_BASE_DIR,
      kind,
    )
  }

  get enabled(): boolean {
    return this.consoleEnabled || this.fileEnabled
  }

  startAttempt(attempt: number, details: DiagnosticDetails = {}): void {
    this.attempt = attempt
    this.event('capture.attempt', `开始第 ${attempt} 次截图尝试`, details)
  }

  event(phase: string, message: string, details: DiagnosticDetails = {}): void {
    if (!this.enabled) return
    const event: DiagnosticEvent = {
      at: new Date().toISOString(),
      elapsedMs: Date.now() - this.startedMs,
      attempt: this.attempt,
      phase,
      message: redactSensitiveText(message),
      ...(Object.keys(details).length ? { details: sanitizeDetails(details) } : {}),
    }
    this.events.push(event)

    if (this.consoleEnabled && shouldWriteConsoleEvent(phase)) {
      const detailText = event.details
        ? ` ${JSON.stringify(omitConsoleStacks(event.details))}`
        : ''
      this.logger.info(`[${this.kind}:${this.captureId}] ${phase} ${event.message}${detailText}`)
    }
  }

  async persistSuccess(
    image: Buffer,
    imageType: ImageType,
    details: DiagnosticDetails = {},
  ): Promise<void> {
    this.event('capture.success', '截图成功', {
      bytes: image.length,
      totalMs: Date.now() - this.startedMs,
      ...details,
    })
    if (!this.fileEnabled) return

    if (this.lastFailure && this.attempt > 1) {
      await this.markLastFailureRecovered(this.attempt)
    }
    await this.persistArtifact('success', image, imageType, undefined, {
      previousAttemptFailed: Boolean(this.lastFailure),
      ...details,
    })
  }

  async persistFailure(
    error: unknown,
    page: Page | undefined,
    imageType: ImageType,
    imageQuality: number,
    details: DiagnosticDetails = {},
  ): Promise<void> {
    let image: Buffer | undefined
    if (this.fileEnabled && page) {
      try {
        const screenshotOptions: any = { type: imageType, fullPage: false }
        if (imageType !== 'png') screenshotOptions.quality = imageQuality
        image = Buffer.from(await page.screenshot(screenshotOptions) as unknown as Uint8Array)
      } catch (screenshotError) {
        this.event('artifact.failure-screenshot', '失败现场截图保存前捕获失败', {
          error: serializeError(screenshotError),
        })
      }
    }

    const serializedError = serializeError(error)
    this.event('capture.failure', '截图尝试失败', {
      totalMs: Date.now() - this.startedMs,
      error: serializedError,
      ...details,
    })
    if (!this.fileEnabled) return

    const persisted = await this.persistArtifact(
      'failure',
      image,
      imageType,
      serializedError,
      details,
    )
    if (persisted) this.lastFailure = persisted
  }

  private async persistArtifact(
    result: 'success' | 'failure',
    image: Buffer | undefined,
    imageType: ImageType,
    error: DiagnosticError | undefined,
    details: DiagnosticDetails,
  ): Promise<PersistedFailure | undefined> {
    const finishedAt = new Date()
    const historyDir = path.join(this.kindDir, result)
    const basename = `${formatFileTimestamp(finishedAt)}-${this.captureId}-a${this.attempt}`
    const historyJsonPath = path.join(historyDir, `${basename}.json`)
    const historyImagePath = path.join(historyDir, `${basename}.${imageType}`)
    const latestJsonPath = path.join(this.kindDir, `latest-${result}.json`)
    const latestImagePath = path.join(this.kindDir, `latest-${result}.${imageType}`)
    const payload: DiagnosticPayload = {
      schemaVersion: 1,
      captureId: this.captureId,
      kind: this.kind,
      result,
      attempt: this.attempt,
      startedAt: this.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - this.startedAt.getTime(),
      recoveredByRetry: false,
      previousAttemptFailed: result === 'success' && Boolean(this.lastFailure),
      config: sanitizeDetails({
        ...this.configSnapshot,
        verboseFileLogPathRelativeToBaseDir: [
          ...VERBOSE_FILE_LOG_PATH_RELATIVE_TO_BASE_DIR,
        ],
      }),
      details: sanitizeDetails(details),
      ...(error ? { error } : {}),
      artifacts: {
        imageCaptured: Boolean(image),
        ...(image ? {
          imageFormat: imageType,
          historyImage: path.relative(this.kindDir, historyImagePath),
          latestImage: path.basename(latestImagePath),
        } : {}),
      },
      events: this.events.map(event => ({ ...event })),
    }

    try {
      await withFileWriteLock(this.kindDir, async () => {
        await mkdir(historyDir, { recursive: true })
        if (image) await writeFile(historyImagePath, image)
        await writeFile(historyJsonPath, safeJson(payload), 'utf8')
        if (image) {
          await removeOtherLatestImages(this.kindDir, result, imageType)
          await copyFile(historyImagePath, latestImagePath)
        } else {
          await Promise.all(IMAGE_TYPES.map(type => (
            rm(path.join(this.kindDir, `latest-${result}.${type}`), { force: true })
          )))
        }
        await copyFile(historyJsonPath, latestJsonPath)
        await pruneHistory(historyDir, this.retention)
      })
      if (this.consoleEnabled) {
        this.logger.info(`[${this.kind}:${this.captureId}] artifact.saved ${latestJsonPath}`)
      }
      if (result === 'failure') {
        return {
          payload,
          historyJsonPath,
          latestJsonPath,
          lockKey: this.kindDir,
        }
      }
    } catch (writeError) {
      this.logger.warn(
        `[${this.kind}:${this.captureId}] 📁 诊断文件写入失败：${serializeError(writeError).message}`,
      )
    }
  }

  private async markLastFailureRecovered(recoveredByAttempt: number): Promise<void> {
    if (!this.lastFailure) return
    const failure = this.lastFailure
    failure.payload.recoveredByRetry = true
    failure.payload.details = {
      ...failure.payload.details,
      recoveredByAttempt,
    }
    try {
      await withFileWriteLock(failure.lockKey, async () => {
        const content = safeJson(failure.payload)
        await writeFile(failure.historyJsonPath, content, 'utf8')

        const latestPayload = await readFile(failure.latestJsonPath, 'utf8')
          .then(value => JSON.parse(value) as Partial<DiagnosticPayload>)
          .catch(() => null)
        if (latestPayload?.captureId === failure.payload.captureId
          && latestPayload.attempt === failure.payload.attempt) {
          await writeFile(failure.latestJsonPath, content, 'utf8')
        }
      })
    } catch (writeError) {
      this.logger.warn(
        `[${this.kind}:${this.captureId}] 📁 恢复状态写入失败：${serializeError(writeError).message}`,
      )
    }
  }
}

export function createCaptureDiagnostics(
  ctx: Context,
  kind: CaptureKind,
  config: Config,
  configSnapshot: DiagnosticDetails,
): CaptureDiagnostics {
  return new CaptureDiagnostics(ctx, kind, config, configSnapshot)
}
