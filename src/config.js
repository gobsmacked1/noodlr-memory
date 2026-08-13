import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

// Minimal .env loader (no dependency). Does not override already-set process.env.
function loadDotEnv() {
  const p = resolve(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const rawLine of readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}
function str(name, fallback = "") {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

const DATA_DIR = resolve(ROOT, str("NOODLR_MEMORY_DATA_DIR", "./data"));

export const config = {
  root: ROOT,
  host: str("NOODLR_MEMORY_HOST", "127.0.0.1"),
  // Set to 0 to disable the TCP listener entirely (socket-only, for a host that should expose no
  // network port at all). Any other value binds host:port.
  port: num("NOODLR_MEMORY_PORT", 3010),
  // Optional Unix domain socket, listened on IN ADDITION to host:port — a socket is the tidy way
  // for a reverse proxy on the same machine to reach the service, but assuming that is the only
  // way anyone wants to reach it presumes a topology (Foundry and this service co-located on
  // Linux) that plenty of deployments don't have. socketMode is applied via chmod so the proxy
  // user (e.g. www-data) can connect. Not supported on Windows.
  socketPath: str("NOODLR_MEMORY_SOCKET", ""),
  socketMode: str("NOODLR_MEMORY_SOCKET_MODE", "660"),
  secret: str("NOODLR_MEMORY_SECRET", ""),
  maxBodyMb: num("NOODLR_MEMORY_MAX_BODY_MB", 32),
  backend: str("VECTOR_BACKEND", "lancedb").toLowerCase(),
  dataDir: DATA_DIR,
  // Embedded LanceDB data directory. Defaults under the service data dir; point it at an
  // existing store (e.g. /opt/lancedb_data) with LANCEDB_URI.
  lancedbUri: str("LANCEDB_URI", resolve(DATA_DIR, "lancedb")),
  chromaUrl: str("CHROMA_URL", "http://localhost:8000"),
  chromaAuthToken: str("CHROMA_AUTH_TOKEN", ""),
  qdrantUrl: str("QDRANT_URL", "http://localhost:6333"),
  qdrantApiKey: str("QDRANT_API_KEY", ""),
  embed: {
    provider: str("EMBED_PROVIDER", "openrouter").toLowerCase(),
    model: str("EMBED_MODEL", "perplexity/pplx-embed-v1-4b"),
    baseUrl: str("EMBED_BASE_URL", ""),
    apiKey: str("EMBED_API_KEY", ""),
    // A requests-per-minute limit counts REQUESTS, not texts, so this is the first and largest
    // lever against one: 16 -> 32 halves the calls for identical work. Capped by
    // maxCharsPerRequest below, so raising it cannot produce a body the provider rejects for length.
    batchSize: num("EMBED_BATCH_SIZE", 32),
    // Split a batch that would exceed this many characters, whatever batchSize says. ~48k chars is
    // roughly 12k tokens, comfortably inside every embedding endpoint's per-request budget.
    maxCharsPerRequest: num("EMBED_MAX_CHARS_PER_REQUEST", 48000),
    hedgeMs: num("EMBED_HEDGE_MS", 15000),
    timeoutMs: num("EMBED_TIMEOUT_MS", 60000),
    maxRetries: num("EMBED_MAX_RETRIES", 5),
    // How long to keep trying a RATE-LIMITED batch, in ms. Attempts are the wrong unit for a rate
    // limit: five retries of exponential backoff from 2s spend themselves inside a single
    // per-minute window and then give up, which is what made a compendium ingest unfinishable.
    rateLimitBudgetMs: num("EMBED_RATE_LIMIT_BUDGET_MS", 600000),
    // First wait after a 429 that carries no Retry-After. A per-minute window does not clear in two
    // seconds, so starting small only burns the budget reaching the same answer.
    rateLimitWaitMs: num("EMBED_RATE_LIMIT_WAIT_MS", 20000),
    // Once a 429 has arrived, the account demonstrably cannot take requests at full speed, so pace
    // them from then on instead of bursting into the same wall every window. Doubles per rate limit,
    // capped, and decays on its own. 0 disables the adaptation.
    paceStepMs: num("EMBED_PACE_STEP_MS", 1000),
    paceMaxMs: num("EMBED_PACE_MAX_MS", 6000),
    // Minimum gap between embedding requests, in ms. 0 = as fast as they complete (with the
    // adaptive pacing above as the safety net). Set it when a provider's limit is known and low:
    // 1200 is roughly 50 requests a minute.
    minIntervalMs: num("EMBED_MIN_INTERVAL_MS", 0),
  },
};
