import { appendFileSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const PREFERRED = "/var/logs/redmine-mcp.log";
const FALLBACK = join(homedir(), ".local", "state", "redmine-mcp.log");

/** Values whose contents must never reach the log. */
const SECRET_KEYS = /api[-_]?key|token|password|secret/i;

function tryOpen(path: string): string | null {
  try {
    mkdirSync(dirname(path), { recursive: true });
    closeSync(openSync(path, "a"));
    return path;
  } catch {
    return null;
  }
}

// Resolved once at startup: explicit override, then /var/logs, then a
// user-writable fallback (/var/logs needs root on most systems).
export const logFile =
  tryOpen(process.env.REDMINE_MCP_LOG ?? PREFERRED) ?? tryOpen(FALLBACK);

let warned = false;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.test(k) ? "[redacted]" : redact(v)]),
    );
  }
  return value;
}

/**
 * Append one JSON line. Never writes to stdout — stdout is the MCP stdio
 * transport, and anything printed there corrupts the protocol stream.
 */
export function log(
  level: "info" | "warn" | "error",
  event: string,
  data: Record<string, unknown> = {},
): void {
  if (!logFile) {
    if (!warned) {
      warned = true;
      console.error(`redmine-mcp: no writable log file (tried ${PREFERRED} and ${FALLBACK})`);
    }
    return;
  }
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...(redact(data) as Record<string, unknown>),
  });
  try {
    appendFileSync(logFile, line + "\n");
  } catch (err) {
    if (!warned) {
      warned = true;
      console.error(`redmine-mcp: log write failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

export function errorInfo(err: unknown): Record<string, unknown> {
  return err instanceof Error
    ? { error: err.message, error_type: err.name, ...("status" in err ? { status: err.status } : {}) }
    : { error: String(err) };
}
