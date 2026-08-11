import { config } from "./config.js";
import { log } from "./logger.js";
import { HttpError, contentHash } from "./sanitize.js";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const MOCK_DIM = 256;

// Merge a per-request embedding config (from the Foundry module) over the
// server defaults from .env. Keys can live server-side (.env) so they never
// leave the service, OR be supplied per request for UI-driven configuration.
export function resolveEmbedConfig(reqEmbed = {}) {
  const d = config.embed;
  const provider = String(reqEmbed.provider || d.provider || "openrouter").toLowerCase();
  return {
    provider,
    model: String(reqEmbed.model || d.model || "").trim(),
    baseUrl: String(reqEmbed.baseUrl || d.baseUrl || "").trim(),
    apiKey: String(reqEmbed.apiKey || d.apiKey || "").trim(),
    batchSize: Number(reqEmbed.batchSize) || d.batchSize || 16,
    hedgeMs: Number.isFinite(Number(reqEmbed.hedgeMs)) ? Number(reqEmbed.hedgeMs) : d.hedgeMs,
    timeoutMs: Number(reqEmbed.timeoutMs) || d.timeoutMs || 60000,
    maxRetries: Number.isFinite(Number(reqEmbed.maxRetries))
      ? Number(reqEmbed.maxRetries)
      : (d.maxRetries ?? 5),
    // A floor on the gap between requests, for an account whose limit is low enough that backoff
    // alone means backing off constantly. Off by default: the retry gate is the correct mechanism,
    // and pacing every request to suit the worst case makes a healthy key needlessly slow.
    minIntervalMs: Number.isFinite(Number(reqEmbed.minIntervalMs))
      ? Number(reqEmbed.minIntervalMs)
      : (d.minIntervalMs ?? 0),
  };
}

const TRANSFORMERS_DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";

function endpointFor(cfg) {
  if (cfg.provider === "openrouter") return `${OPENROUTER_BASE}/embeddings`;
  if (cfg.provider === "custom") {
    if (!cfg.baseUrl) throw new HttpError(400, "custom embedding provider requires a baseUrl");
    return `${cfg.baseUrl.replace(/\/+$/, "")}/embeddings`;
  }
  if (cfg.provider === "mock") return "mock://embeddings";
  if (cfg.provider === "transformers") return "transformers://local"; // in-process, no network
  throw new HttpError(400, `Unknown embedding provider "${cfg.provider}"`);
}

// In-process local embeddings via Transformers.js (no external service). The
// ONNX model is downloaded from HuggingFace once and cached on disk. Optional
// dependency so the service still runs without it when using a cloud/API provider.
let _extractor = null;
let _extractorModel = null;
async function transformersEmbed(texts, model) {
  const wanted = model && model.includes("/") ? model : TRANSFORMERS_DEFAULT_MODEL;
  if (!_extractor || _extractorModel !== wanted) {
    let mod;
    try {
      mod = await import("@huggingface/transformers");
    } catch {
      try {
        mod = await import("@xenova/transformers");
      } catch {
        throw new HttpError(
          501,
          "in-process local embeddings need the optional '@huggingface/transformers' dependency (run: npm i @huggingface/transformers)",
        );
      }
    }
    log.info(`Loading local embedding model ${wanted} (first run downloads it)...`);
    _extractor = await mod.pipeline("feature-extraction", wanted);
    _extractorModel = wanted;
  }
  const output = await _extractor(texts, { pooling: "mean", normalize: true });
  return output.tolist();
}

// Deterministic, network-free embedding for tests and offline smoke checks.
// A bag-of-tokens hashed into a fixed-dim vector, L2-normalized. Similar text
// yields similar vectors, which is enough to validate the round-trip plumbing.
function mockEmbed(text) {
  const vec = new Array(MOCK_DIM).fill(0);
  const tokens = String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const tok of tokens) {
    vec[contentHash(tok) % MOCK_DIM] += 1;
  }
  let norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((x) => x / norm);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A rate limit belongs to the API key, so backing off from one has to be shared too.
 *
 * A 429 says the account is over its limit, not that this request was unlucky. Anything else in
 * flight -- the other half of a hedged pair, a query that arrived while an ingest was running -- is
 * over the same limit and must wait as well, or they retry into the same wall together. One
 * process-wide gate: whoever is told to wait sets the time and everybody honours it. Lifted from the
 * corpus miner, which learned this over runs of several thousand unattended calls.
 */
let pausedUntil = 0;
/** When the last 429 arrived, so hedging can stand down while the provider is refusing work. */
let lastRateLimitAt = 0;
/** Earliest the next request may leave, for the optional fixed pacing. */
let nextSlotAt = 0;

async function awaitGate() {
  for (;;) {
    const remaining = Math.max(pausedUntil, nextSlotAt) - Date.now();
    if (remaining <= 0) return;
    await sleep(remaining);
  }
}

function pauseAll(ms) {
  pausedUntil = Math.max(pausedUntil, Date.now() + ms);
  lastRateLimitAt = Date.now();
}

/** Test seam: forget any pause, so one test's rate limit does not leak into the next. */
export function resetRateLimitGate() {
  pausedUntil = 0;
  lastRateLimitAt = 0;
  nextSlotAt = 0;
}

/** True while a 429 is recent enough that a second concurrent request would only make it worse. */
function rateLimited() {
  return Date.now() < pausedUntil || Date.now() - lastRateLimitAt < 60_000;
}

async function postEmbeddings(endpoint, cfg, batch, signal) {
  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://noodlr.app";
    headers["X-Title"] = "Noodlr Memory";
  }
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: cfg.model, input: batch }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new HttpError(
      res.status >= 500 ? 502 : 400,
      `embedding provider ${res.status}: ${body.slice(0, 300)}`,
    );
    // 429 is rate limiting and 5xx is the provider having a moment; both pass with time. Everything
    // else (401, 402, a bad model slug) is a fault in how we are asking and will never pass, so
    // retrying it just spends the caller's patience to reach the same answer.
    err.providerStatus = res.status;
    err.retryable = res.status === 429 || res.status >= 500;
    err.retryAfter = Number(res.headers.get("retry-after")) || 0;
    throw err;
  }
  const json = await res.json();
  if (!Array.isArray(json.data)) throw new HttpError(502, "embedding provider returned no data[]");
  return json.data
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => d.embedding);
}

/**
 * One batch, with hedging and rate-limit patience.
 *
 * Hedging (fire a duplicate when the first request stalls, first answer wins -- the VectFox pattern)
 * is a latency trick that assumes a healthy provider with an unlucky connection. A rate-limited
 * provider is neither: requests get SLOW, which is exactly the condition that fires the hedge, so it
 * doubles the request rate at the moment the account can least afford it. It stands down for a
 * minute after any 429 and comes back on its own.
 */
async function embedBatchHedged(endpoint, cfg, batch) {
  if (cfg.provider === "mock") return batch.map(mockEmbed);
  if (cfg.provider === "transformers") return transformersEmbed(batch, cfg.model);

  const attempt = () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
    if (cfg.minIntervalMs > 0) nextSlotAt = Date.now() + cfg.minIntervalMs;
    return postEmbeddings(endpoint, cfg, batch, ac.signal).finally(() => clearTimeout(timer));
  };

  const once = () => {
    if (!cfg.hedgeMs || cfg.hedgeMs <= 0 || rateLimited()) return attempt();
    const first = attempt();
    let hedgeTimer;
    const hedge = new Promise((resolve, reject) => {
      hedgeTimer = setTimeout(() => attempt().then(resolve, reject), cfg.hedgeMs);
    });
    return Promise.race([first, hedge]).finally(() => clearTimeout(hedgeTimer));
  };

  let tries = 0;
  for (;;) {
    tries++;
    await awaitGate();
    try {
      return await once();
    } catch (err) {
      const isAbort = err?.name === "AbortError";
      // A TypeError from fetch is a dropped connection rather than a refusal, and passes with time.
      const retryable = isAbort || err?.retryable || err?.name === "TypeError";
      if (!retryable || tries > cfg.maxRetries) throw err;
      const wait = err?.retryAfter
        ? err.retryAfter * 1000
        : Math.min(60_000, 2 ** tries * 1000) + Math.random() * 1000;
      log.warn(
        `embed retry ${tries}/${cfg.maxRetries} in ${Math.round(wait / 1000)}s: ${err.message}`,
      );
      // Only a rate limit is everyone's problem. Stalling every other request for one timeout would
      // throw away throughput for nothing.
      if (err?.providerStatus === 429) pauseAll(wait);
      await sleep(wait);
    }
  }
}

// Reject vectors a vector store can't search: non-arrays, non-finite values (NaN/Inf), or a
// dimension that varies between items. A provider that returns these makes vectorSearch throw a
// cryptic "Failed to execute query" AFTER the bad rows are already stored — so we fail loud and
// early with the actual reason instead. (base64-encoded embeddings, for example, arrive as strings
// and are caught here.)
function assertValidVectors(vectors, model) {
  let dim = null;
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    if (!Array.isArray(v)) {
      throw new HttpError(
        502,
        `embedding provider returned a non-array vector for item ${i} (got ${typeof v}). Model "${model}" may be returning base64/objects instead of float arrays.`,
      );
    }
    if (dim === null) dim = v.length;
    else if (v.length !== dim) {
      throw new HttpError(
        502,
        `embedding dimension varies within one request (${dim} vs ${v.length} at item ${i}). The provider/model "${model}" is returning inconsistent vectors — pin a single provider.`,
      );
    }
    for (let j = 0; j < v.length; j++) {
      const x = v[j];
      if (typeof x !== "number" || !Number.isFinite(x)) {
        throw new HttpError(
          502,
          `embedding for item ${i} contains a non-finite value (${x}) at index ${j}. Model "${model}" returned an unusable vector.`,
        );
      }
    }
  }
  return dim;
}

/**
 * Embed an array of texts. Batches by cfg.batchSize; on a batch failure, retries
 * that batch one item at a time so a single bad/stuck item can't sink the run.
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(texts, reqEmbed) {
  const cfg = resolveEmbedConfig(reqEmbed);
  const modelOptional = cfg.provider === "mock" || cfg.provider === "transformers";
  if (!modelOptional && !cfg.model) {
    throw new HttpError(400, "embedding model is required");
  }
  const endpoint = endpointFor(cfg);
  const out = new Array(texts.length);
  for (let start = 0; start < texts.length; start += cfg.batchSize) {
    const idxs = [];
    const batch = [];
    for (let i = start; i < Math.min(start + cfg.batchSize, texts.length); i++) {
      idxs.push(i);
      batch.push(texts[i]);
    }
    try {
      const vecs = await embedBatchHedged(endpoint, cfg, batch);
      idxs.forEach((idx, k) => (out[idx] = vecs[k]));
    } catch (err) {
      // The split exists for a POISON ITEM -- one document the provider chokes on, which would
      // otherwise sink the fifteen good ones beside it. A rate limit is not that, and splitting on
      // one turns a single refused batch into batchSize more requests fired immediately at an
      // endpoint that just said stop. It is an amplifier dressed as a mitigation, so a batch that
      // ran out of retry patience is reported rather than fanned out.
      if (err?.providerStatus === 429) throw err;
      log.warn(`embed batch failed (${err.message}); retrying ${batch.length} items individually`);
      for (let k = 0; k < batch.length; k++) {
        out[idxs[k]] = (await embedBatchHedged(endpoint, cfg, [batch[k]]))[0];
      }
    }
  }
  assertValidVectors(out, cfg.model || cfg.provider);
  return out;
}
