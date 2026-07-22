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
    throw new HttpError(res.status >= 500 ? 502 : 400, `embedding provider ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  if (!Array.isArray(json.data)) throw new HttpError(502, "embedding provider returned no data[]");
  return json.data
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => d.embedding);
}

// One batch with hedging: if the first request stalls past hedgeMs, fire a
// duplicate on a fresh connection; first to answer wins (VectFox pattern).
async function embedBatchHedged(endpoint, cfg, batch) {
  if (cfg.provider === "mock") return batch.map(mockEmbed);
  if (cfg.provider === "transformers") return transformersEmbed(batch, cfg.model);

  const attempt = () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
    return postEmbeddings(endpoint, cfg, batch, ac.signal).finally(() => clearTimeout(timer));
  };

  if (!cfg.hedgeMs || cfg.hedgeMs <= 0) return attempt();

  const first = attempt();
  let hedgeTimer;
  const hedge = new Promise((resolve, reject) => {
    hedgeTimer = setTimeout(() => attempt().then(resolve, reject), cfg.hedgeMs);
  });
  try {
    return await Promise.race([first, hedge]);
  } finally {
    clearTimeout(hedgeTimer);
  }
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
      log.warn(`embed batch failed (${err.message}); retrying ${batch.length} items individually`);
      for (let k = 0; k < batch.length; k++) {
        out[idxs[k]] = (await embedBatchHedged(endpoint, cfg, [batch[k]]))[0];
      }
    }
  }
  return out;
}
