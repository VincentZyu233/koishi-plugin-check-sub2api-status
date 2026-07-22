const ANSI = {
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  blue: '\u001B[34m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  magenta: '\u001B[35m',
  cyan: '\u001B[36m',
  red: '\u001B[31m',
}

const forceColor = process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0'
const colorEnabled = !('NO_COLOR' in process.env)
  && process.env.TERM !== 'dumb'
  && (forceColor || process.stdout.isTTY || process.stderr.isTTY)

function styledPrefix(emoji, color, message) {
  const prefix = `${emoji} ${message}`
  if (!colorEnabled) return prefix
  return `${ANSI.bold}${ANSI[color]}${prefix}${ANSI.reset}`
}

function write(writer, emoji, color, message, detail) {
  const suffix = detail === undefined || detail === '' ? '' : ` ${detail}`
  writer(`${styledPrefix(emoji, color, message)}${suffix}`)
}

export function logInfo(message, detail) {
  write(console.log, 'ℹ️', 'cyan', message, detail)
}

export function logPath(message, detail) {
  write(console.log, '📂', 'blue', message, detail)
}

export function logStep(message, detail) {
  write(console.log, '⏳', 'yellow', message, detail)
}

export function logSuccess(message, detail) {
  write(console.log, '✅', 'green', message, detail)
}

export function logWarning(message, detail) {
  write(console.error, '⚠️', 'magenta', message, detail)
}

export function logError(message, detail) {
  write(console.error, '❌', 'red', message, detail)
}

export function logSummary(message, succeeded) {
  write(console.log, '📊', succeeded ? 'green' : 'red', message)
}

export function logHelp(message) {
  write(console.log, '🧭', 'cyan', message)
}

export function formatError(error) {
  if (error instanceof Error) return error.stack || error.message
  return String(error)
}
