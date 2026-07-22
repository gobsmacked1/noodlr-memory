// Tiny structured logger. Never logs secrets.
function ts() {
  return new Date().toISOString();
}
export const log = {
  info: (...a) => console.log(`[${ts()}] [info]`, ...a),
  warn: (...a) => console.warn(`[${ts()}] [warn]`, ...a),
  error: (...a) => console.error(`[${ts()}] [error]`, ...a),
};

// Redact anything that looks like a bearer token / api key for safe logging.
export function redact(value) {
  if (typeof value !== "string") return value;
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}...${value.slice(-2)}`;
}
