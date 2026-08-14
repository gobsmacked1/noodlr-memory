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
    // Provider redundancy is a selection criterion for an embedding model, not a footnote. Measured
    // 2026-08-13 with `probe-rate.mjs routing`: this model is served by three providers (Nebius,
    // DeepInfra, SiliconFlow) and the previous default, perplexity/pplx-embed-v1-4b, by exactly one.
    // With one endpoint OpenRouter has nothing to fail over to, so that provider's saturation — caused
    // by anyone's traffic — arrives as a 429 however slowly you ask; with three the same event is
    // absorbed invisibly. Switching models is what actually ended a week of refusals that no amount of
    // batching, backoff or pacing had fixed, because none of them addressed the cause.
    // NOTE: changing this changes the VECTOR WIDTH, and a collection's width is fixed when its table is
    // first written. An existing store must be purged and re-ingested; mixing the two makes every query
    // against an older silo fail on a dimension mismatch.
    model: str("EMBED_MODEL", "qwen/qwen3-embedding-8b"),
    baseUrl: str("EMBED_BASE_URL", ""),
    apiKey: str("EMBED_API_KEY", ""),
    // A requests-per-minute limit counts REQUESTS, not texts, so this is the first and largest
    // lever against one: each doubling halves the calls for identical work, and 16 -> 64 is a
    // straight quarter. Capped by maxCharsPerRequest below, so raising it cannot produce a body the
    // provider rejects for length -- which is what makes the advice safe to follow rather than a
    // trade of one failure for another.
    batchSize: num("EMBED_BATCH_SIZE", 64),
    // Split a batch that would exceed this many characters, whatever batchSize says. ~48k chars is
    // roughly 12k tokens, comfortably inside every embedding endpoint's per-request budget.
    maxCharsPerRequest: num("EMBED_MAX_CHARS_PER_REQUEST", 48000),
    hedgeMs: num("EMBED_HEDGE_MS", 15000),
    timeoutMs: num("EMBED_TIMEOUT_MS", 60000),
    maxRetries: num("EMBED_MAX_RETRIES", 5),
    // How long the service will keep ONE HTTP request open waiting out a rate limit, in ms.
    //
    // Attempts are the wrong unit for a rate limit -- five exponential retries from 2s all land
    // inside a single per-minute window and then give up -- but so is a very long hold. 600000 (the
    // 1.2.0 default) meant the service vanished for up to ten minutes mid-request, which fails two
    // ways at once: a reverse proxy cuts the connection first (nginx proxy_read_timeout defaults to
    // 60s) and, worse, the CALLER cannot see the wait, so noodlr's ingest queue reported "sending"
    // with no countdown and read as a hang. The caller is the side with a progress bar, a cancel
    // button and a resume index, so the long wait belongs there: the service rides out a blip, then
    // hands back a 429 and stays paced. Keep this under any proxy read timeout in front of it.
    rateLimitBudgetMs: num("EMBED_RATE_LIMIT_BUDGET_MS", 45000),
    // First wait after a 429 that carries no Retry-After. MEASURED, not reasoned — and measured
    // twice, which turned out to matter more than either number.
    //
    // 1.1.1 through 1.2.1 set this to 20s on the reasoning that "a per-minute window does not clear
    // in two seconds". The reasoning was sound and the premise was wrong; 1.3.1 cut it to 1s off an
    // operator's generation log, and 1.3.2 to 250ms because `scripts/probe-rate.mjs recover` cleared
    // on its first 250ms retry. A second run of the same probe against the same host was still
    // refused at 250ms and cleared at 500ms. So the recovery time is NOT a constant waiting to be
    // matched — it is whatever that provider's saturation happens to be in that instant — and 500 is
    // the top of the observed range, not a newer measurement superseding an older one.
    //
    // Sized to the TOP of the range deliberately. Undershoot and the retry is a request spent on a
    // provider that is still refusing, which is waste against the exact resource that is scarce;
    // overshoot and the cost is idle milliseconds on a rare event. The ladder doubles from here
    // (0.5s, 1s, 2s, 4s, 8s, 16s, all inside the 45s hold), so a genuinely window-shaped limit is
    // still reached in a few cheap attempts, and Retry-After beats any schedule we could invent.
    //
    // STOP RE-TUNING THIS unless a probe reports something an order of magnitude larger. Three
    // releases cut it on better evidence each time, which was right; a fourth cut chasing a 250ms
    // sample would be fitting to noise, and the doubling ladder is what absorbs the variance.
    //
    // What both runs agree on matters more than the wait: the refusal lands on a COLD process with
    // one or two requests behind it (the first request in one run, the second in the other). A limit
    // our own rate could trip cannot behave that way. It is a single-provider model's shared capacity
    // saying "not right now", which is why every remedy shaped like "ask more slowly" is off below.
    rateLimitWaitMs: num("EMBED_RATE_LIMIT_WAIT_MS", 500),
    // Self-pacing after a 429: OFF by default as of 1.3.1, and the default is the whole decision.
    //
    // The mechanism assumed a 429 proves "the account cannot take requests at this rate", which only
    // holds for a limit on the key. When the refusal is an upstream model's capacity — shared with
    // every other OpenRouter caller of that model — our rate was never the cause, so slowing down
    // cannot fix it and the pacing is pure loss: it applied process-wide, for PACE_DECAY_MS after the
    // last refusal, to every later request including an interactive query and the next diagnostics
    // self-test. That is how one transient hiccup came to present as a service that could no longer
    // run its own self-test. Set EMBED_PACE_MAX_MS above 0 only for a limit you have measured and
    // know to be the key's; EMBED_MIN_INTERVAL_MS is the honest lever for a known low limit, because
    // it is a number the operator chose rather than one a failure taught us.
    paceStepMs: num("EMBED_PACE_STEP_MS", 1000),
    paceMaxMs: num("EMBED_PACE_MAX_MS", 0),
    // Minimum gap between embedding requests, in ms. 0 = as fast as they complete (with the
    // adaptive pacing above as the safety net). Set it when a provider's limit is known and low:
    // 1200 is roughly 50 requests a minute.
    minIntervalMs: num("EMBED_MIN_INTERVAL_MS", 0),
  },
};
