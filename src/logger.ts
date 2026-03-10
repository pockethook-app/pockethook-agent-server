/**
 * Structured logger with JSON output and log levels.
 *
 * In production (NODE_ENV=production), outputs JSON lines.
 * In development, outputs human-readable colored text.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";
const isProduction = process.env.NODE_ENV === "production";

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function formatJson(level: LogLevel, message: string, data?: Record<string, unknown>): string {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: message,
  };
  if (data) Object.assign(entry, data);
  return JSON.stringify(entry);
}

function formatText(level: LogLevel, message: string, data?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] ${level.toUpperCase().padEnd(5)}`;
  const extra = data ? " " + JSON.stringify(data) : "";
  return `${prefix} ${message}${extra}`;
}

function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const output = isProduction ? formatJson(level, message, data) : formatText(level, message, data);
  if (level === "error") {
    console.error(output);
  } else if (level === "warn") {
    console.warn(output);
  } else {
    console.log(output);
  }
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => log("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log("error", msg, data),
};
