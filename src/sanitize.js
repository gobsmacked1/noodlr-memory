import sanitizeFilename from "sanitize-filename";
import { isValidCollection } from "./collections.js";

// Collections are strictly allow-listed (see collections.js). We still run the
// value through sanitize-filename before it is ever used as a path segment, so a
// bad value can never traverse directories even if the allowlist is bypassed.
export function safeCollection(id) {
  const raw = String(id ?? "").trim();
  if (!isValidCollection(raw)) {
    throw new HttpError(400, `Unknown collection "${raw}"`);
  }
  const clean = sanitizeFilename(raw);
  if (!clean || clean !== raw) {
    throw new HttpError(400, `Invalid collection id "${raw}"`);
  }
  return clean;
}

export function safePathSegment(value, label = "value") {
  const clean = sanitizeFilename(String(value ?? ""));
  if (!clean) throw new HttpError(400, `Invalid ${label}`);
  return clean;
}

export function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function clampFloat(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// FNV-1a 32-bit, returned as an unsigned int. Stable content hash used for
// dedup and hash-based deletes (mirrors SillyTavern's numeric-hash approach).
export function contentHash(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
