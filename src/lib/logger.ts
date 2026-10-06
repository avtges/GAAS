/**
 * Structured JSON logger with secret redaction. Never pass tokens to it, but if a
 * caller does, the redactor removes anything that looks like one.
 */
type Level = "debug" | "info" | "warn" | "error";

const SECRET_KEY_PATTERN = /(token|secret|authorization|password|cookie|api[-_]?key|client_secret)/i;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g;
const GOOGLE_TOKEN_PATTERN = /\b(ya29\.[A-Za-z0-9\-_]+|1\/\/[A-Za-z0-9\-_]+)\b/g;
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9\-_]{10,}\b/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") {
    return value
      .replace(BEARER_PATTERN, "Bearer [redacted]")
      .replace(GOOGLE_TOKEN_PATTERN, "[redacted]")
      .replace(OPENAI_KEY_PATTERN, "[redacted]");
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1), stack: undefined };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => {
    if (process.env.LOG_LEVEL === "debug") emit("debug", msg, fields);
  },
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
