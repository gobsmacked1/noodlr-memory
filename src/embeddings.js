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
  const provider = String(
    reqEmbed.provider || d.provider || "openrouter",
  ).toLowerCase();
  return {
    provider,
    model: String(reqEmbed.model || d.model || "").trim(),
    baseUrl: String(reqEmbed.baseUrl || d.baseUrl || "").trim(),
    apiKey: String(reqEmbed.apiKey || d.apiKey || "").trim(),
    // Clamped because it arrives from a browser form: a zero would divide the work into empty
    // batches forever and a five-figure value would be rejected by the provider on length.
    batchSize: Math.max(
      1,
      Math.min(
        256,
        Math.round(Number(reqEmbed.batchSize) || d.batchSize || 64),
      ),
    ),
    maxCharsPerRequest:
      Number(reqEmbed.maxCharsPerRequest) || d.maxCharsPerRequest || 48000,
    hedgeMs: Number.isFinite(Number(reqEmbed.hedgeMs))
      ? Number(reqEmbed.hedgeMs)
      : d.hedgeMs,
    timeoutMs: Number(reqEmbed.timeoutMs) || d.timeoutMs || 60000,
    maxRetries: Number.isFinite(Number(reqEmbed.maxRetries))
      ? Number(reqEmbed.maxRetries)
      : (d.maxRetries ?? 5),
    rateLimitBudgetMs: Number.isFinite(Number(reqEmbed.rateLimitBudgetMs))
      ? Number(reqEmbed.rateLimitBudgetMs)
      : (d.rateLimitBudgetMs ?? 600_000),
    // These `??` arms only run if config.embed is missing the key entirely, so they are a second
    // statement of the default and have to agree with config.js — a stale one here is a value nobody
    // chose, arriving on exactly the path (a hand-built cfg in a test or a caller) where it is least
    // likely to be noticed. See EMBED_RATE_LIMIT_WAIT_MS and EMBED_PACE_MAX_MS there for the whys.
    rateLimitWaitMs: Number.isFinite(Number(reqEmbed.rateLimitWaitMs))
      ? Number(reqEmbed.rateLimitWaitMs)
      : (d.rateLimitWaitMs ?? 250),
    paceStepMs: Number.isFinite(Number(reqEmbed.paceStepMs))
      ? Number(reqEmbed.paceStepMs)
      : (d.paceStepMs ?? 1000),
    paceMaxMs: Number.isFinite(Number(reqEmbed.paceMaxMs))
      ? Number(reqEmbed.paceMaxMs)
      : (d.paceMaxMs ?? 0),
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
    if (!cfg.baseUrl)
      throw new HttpError(400, "custom embedding provider requires a baseUrl");
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
  const wanted =
    model && model.includes("/") ? model : TRANSFORMERS_DEFAULT_MODEL;
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
    log.info(
      `Loading local embedding model ${wanted} (first run downloads it)...`,
    );
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
  const tokens =
    String(text)
      .toLowerCase()
      .match(/[a-z0-9]+/g) || [];
  for (const tok of tokens) {
    vec[contentHash(tok) % MOCK_DIM] += 1;
  }
  let norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((x) => x / norm);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A duration for a human, honest below a second.
 *
 * Everything here used to print `Math.round(ms / 1000)}s`, which was fine while every wait was
 * measured in tens of seconds and became a lie the moment they were measured properly: a 250ms retry
 * reported as "waiting 0s" and a 120ms learned gap as "pacing now 0s between requests". A log line
 * that rounds the interesting number away is worse than no line, because it looks like a bug in the
 * mechanism rather than in the reporting.
 */
function dur(ms) {
  const n = Math.max(0, Math.round(ms));
  if (n < 1000) return `${n}ms`;
  return n % 1000 === 0 || n >= 10_000
    ? `${Math.round(n / 1000)}s`
    : `${(n / 1000).toFixed(1)}s`;
}

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
/**
 * Pacing the service taught itself from a 429, on top of any configured floor.
 *
 * Waiting out a rate limit and then resuming at full speed walks into the same wall on the next
 * window, so a long run becomes stall, burst, stall for as long as it lasts -- which is what made a
 * compendium ingest look unfinishable even though every individual retry was working. One 429 is
 * proof the account cannot take requests at this rate, so the rate comes down and stays down until
 * a quiet stretch says otherwise.
 */
let adaptivePaceMs = 0;
/**
 * How long without a refusal before the learned pacing is given up.
 *
 * Must comfortably exceed the longest single rate-limit wait, or the mechanism erases itself exactly
 * when it is needed: a 60s wait would count as a quiet minute and reset the pace to zero immediately
 * before the retry that provoked it.
 */
const PACE_DECAY_MS = 300_000;

function paceInterval(cfg) {
  if (adaptivePaceMs > 0 && Date.now() - lastRateLimitAt > PACE_DECAY_MS)
    adaptivePaceMs = 0;
  return Math.max(cfg.minIntervalMs || 0, adaptivePaceMs);
}

async function awaitGate() {
  for (;;) {
    const remaining = Math.max(pausedUntil, nextSlotAt) - Date.now();
    if (remaining <= 0) return;
    await sleep(remaining);
  }
}

function pauseAll(ms, cfg) {
  pausedUntil = Math.max(pausedUntil, Date.now() + ms);
  lastRateLimitAt = Date.now();
  const step = cfg?.paceStepMs ?? 0;
  const max = cfg?.paceMaxMs ?? 0;
  // Both have to be set for the adaptation to exist at all. It ships off (max 0) because a learned
  // pace is only justified when the limit belongs to the key; see EMBED_PACE_MAX_MS in config.js.
  if (step > 0 && max > 0) {
    const next = adaptivePaceMs > 0 ? adaptivePaceMs * 2 : step;
    adaptivePaceMs = Math.min(max, next);
  }
}

/** Test seam: forget any pause, so one test's rate limit does not leak into the next. */
export function resetRateLimitGate() {
  pausedUntil = 0;
  lastRateLimitAt = 0;
  nextSlotAt = 0;
  adaptivePaceMs = 0;
}

/** What the gate currently believes, for the diagnostics report. */
export function rateLimitState() {
  return {
    pausedForMs: Math.max(0, pausedUntil - Date.now()),
    pacingMs: adaptivePaceMs,
    lastRateLimitAt: lastRateLimitAt || null,
  };
}

/**
 * How long after a refusal a second concurrent request is still assumed to make things worse.
 *
 * This was a flat minute, sized for the same imagined per-minute window as the old 20s wait, and it
 * is the wrong unit for what was measured: `probe-rate.mjs recover` cleared the refusal on the first
 * retry 250ms later. A minute of margin around a quarter-second event means one blip during a bulk
 * ingest switches hedging off for the interactive query that arrives ten seconds later — and a query
 * is the only thing hedging still serves, since it now fires for a single text only. Seconds, not
 * minutes: long enough to cover a refusal that needs a couple of rungs of the ladder, short enough
 * that a recovered blip does not go on costing anything.
 */
const REFUSAL_SETTLE_MS = 5_000;

/**
 * Cumulative wait within one batch before a refusal stops being routine and becomes a report.
 *
 * A single-provider model refuses the occasional request as a matter of course — the measured one hit
 * the very first call out of a cold process — and we retry it away in a quarter of a second. Logging
 * that at `warn`, with a paragraph of remedies, is how a working ingest came to read as a broken
 * service; the operator's report was that it "isn't even able to perform the self-test without being
 * throttled and erroring", and by then the self-test had in fact succeeded. Same doctrine as the
 * module's own failure classifier: severity has to track what the operator should DO, and there is
 * nothing to do about a refusal we already recovered from.
 */
const REFUSAL_NOISE_MS = 5_000;

/** True while a 429 is recent enough that a second concurrent request would only make it worse. */
function rateLimited() {
  return (
    Date.now() < pausedUntil || Date.now() - lastRateLimitAt < REFUSAL_SETTLE_MS
  );
}

/**
 * Which limiter refused us, because the two have different remedies and naming the wrong one costs
 * the operator money to reach the same wall.
 *
 * OpenRouter returns its OWN platform limit as `{error:{code:429, metadata:{error_type:
 * "rate_limit_exceeded"}}}` alongside `X-RateLimit-Limit`, `-Remaining` and `-Reset` headers, and
 * that one is fixable from the account side: buy credits to raise a free-model daily cap, or move off
 * a `:free` variant. When the UPSTREAM provider refuses, OpenRouter relays that body verbatim behind
 * an `HTTP <status>:` prefix and sends no `X-RateLimit-*` at all — the limit belongs to a model's
 * capacity rather than to the key, so no amount of spending changes it and the only levers are a
 * different model, a different provider, or a slower request rate. Telling somebody to top up an
 * account that was never the problem is worse than saying nothing.
 *
 * Headers decide it where they exist because they are unambiguous; the nested-body shape is the
 * fallback. "unknown" carries no advice rather than a guess.
 */
function limiterOf(res, body, batchSize = 0) {
  const limit = res.headers.get("x-ratelimit-limit");
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = res.headers.get("x-ratelimit-reset");
  const relayed =
    /^\s*(?:\{\s*"error".*)?HTTP \d{3}:/.test(body) ||
    /\\"type\\":\s*\\"\w*rate/.test(body);

  let scope = "unknown";
  if (limit || remaining || reset) scope = "account";
  else if (relayed) scope = "upstream";
  else if (/"error_type"\s*:\s*"rate_limit_exceeded"/.test(body))
    scope = "account";

  const detail = [
    limit ? `limit ${limit}` : "",
    remaining ? `remaining ${remaining}` : "",
    reset ? `resets ${reset}` : "",
  ]
    .filter(Boolean)
    .join(", ");

  // The remedy depends on how big the refused request was, and getting that wrong sends the operator
  // to tune a knob that provably cannot help: ONE text is the smallest request that exists, so a
  // refusal there is not about our rate and neither pacing nor batching has anywhere left to go.
  const single = batchSize > 0 && batchSize <= 1;
  const advice =
    scope === "account"
      ? "this is OpenRouter's own limit on the key: buying credits raises a free-model cap, or move off the :free variant"
      : scope === "upstream"
        ? "this is the UPSTREAM provider refusing, relayed by OpenRouter — credits will not change it. " +
          (single
            ? "This was a request for a SINGLE text, so the request rate is already as low as it goes: " +
              "EMBED_MIN_INTERVAL_MS and EMBED_BATCH_SIZE cannot help, and the model itself has no " +
              "capacity for you right now. Change EMBED_MODEL, or set EMBED_PROVIDER=transformers to " +
              "embed in-process with no limit at all."
            : "Raise EMBED_BATCH_SIZE so the same work is fewer requests, slow the request rate " +
              "(EMBED_MIN_INTERVAL_MS), or use a different embedding model. " +
              "EMBED_PROVIDER=transformers embeds in-process with no limit at all.")
        : "";

  return { scope, detail, advice, resetHeader: reset };
}

/**
 * How many providers OpenRouter can route a model to, asked once, only after a refusal.
 *
 * This is the fact that explains a single-text 429, and no part of the response carries it: a model
 * served by ONE provider gives OpenRouter nothing to fail over to, so that provider's saturation —
 * by anyone's traffic, not only ours — arrives here as a refusal however slowly we ask. A model with
 * two or three endpoints absorbs the same event invisibly. Without this line the operator reads
 * "rate limit", reasonably concludes they are asking too fast, and tunes knobs that cannot move.
 *
 * Public catalogue, no key, best-effort and cached including the failure: a run that is already being
 * refused must not turn into a second stream of requests, and an unreachable catalogue means we say
 * nothing rather than guess.
 */
const routingNotes = new Map();

async function routingNote(model) {
  if (!model) return "";
  if (routingNotes.has(model)) return routingNotes.get(model);
  routingNotes.set(model, ""); // claim it first: a concurrent refusal must not ask twice
  let note = "";
  try {
    const res = await fetch(
      `https://openrouter.ai/api/v1/models/${encodeURIComponent(model).replace(/%2F/g, "/")}/endpoints`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (res.ok) {
      const json = await res.json();
      const eps = json?.data?.endpoints;
      if (Array.isArray(eps) && eps.length > 0) {
        const names = eps.map((e) => e.provider_name).filter(Boolean);
        note =
          eps.length === 1
            ? `"${model}" is served by exactly ONE provider (${names[0] || "unknown"}), so OpenRouter has ` +
              "nothing to fail over to and that provider's own saturation reaches you directly. A model " +
              "with several providers absorbs this invisibly — see the embeddings list at " +
              "https://openrouter.ai/models?fmt=table&output_modalities=embeddings"
            : `"${model}" has ${eps.length} providers (${names.join(", ")}), so this refusal is not a routing dead end`;
      }
    }
  } catch {
    // Never worth reporting: this is colour on a failure that is already fully described.
  }
  routingNotes.set(model, note);
  return note;
}

/** A wait implied by the reset header, in ms, or 0 when it says nothing usable. */
function waitFromReset(reset) {
  const n = Number(reset);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // The header is documented as describing the limit's reset without pinning a unit, and the three
  // plausible readings are far enough apart to tell by magnitude: a delta in seconds, epoch seconds,
  // or epoch milliseconds. Anything that reduces to an implausible wait is discarded rather than
  // guessed at — a bad reading here would either spin hot or park the run for hours.
  const now = Date.now();
  const candidates = [n * 1000, n * 1000 - now, n - now];
  for (const ms of candidates) {
    if (ms > 0 && ms <= 600_000) return ms;
  }
  return 0;
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
    // The status is passed through for 429 rather than flattened to 400, so a caller can tell "the
    // account is over its limit, try later" from "you are asking wrongly" without reading the
    // message. The module's ingest loop keys its own patience off exactly this.
    const err = new HttpError(
      res.status === 429 ? 429 : res.status >= 500 ? 502 : 400,
      `embedding provider ${res.status}: ${body.slice(0, 300)}`,
    );
    // 429 is rate limiting and 5xx is the provider having a moment; both pass with time. Everything
    // else (401, 402, a bad model slug) is a fault in how we are asking and will never pass, so
    // retrying it just spends the caller's patience to reach the same answer.
    err.providerStatus = res.status;
    err.retryable = res.status === 429 || res.status >= 500;
    err.retryAfter = Number(res.headers.get("retry-after")) || 0;
    if (res.status === 429) {
      const who = limiterOf(res, body, batch.length);
      err.batchSize = batch.length;
      err.model = cfg.model;
      err.limiter = who.scope;
      err.limiterDetail = who.detail;
      err.limiterAdvice = who.advice;
      if (!err.retryAfter) err.resetWaitMs = waitFromReset(who.resetHeader);
    }
    throw err;
  }
  const json = await res.json();
  if (!Array.isArray(json.data))
    throw new HttpError(502, "embedding provider returned no data[]");
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
 * minute after any 429 and comes back on its own -- but that is a reaction, and by then the hedge has
 * been doubling the rate for the whole run up to the first refusal, so it is a plausible CAUSE of
 * that refusal rather than merely an aggravator. Hence the batch-size gate in `once`.
 */
async function embedBatchHedged(endpoint, cfg, batch) {
  if (cfg.provider === "mock") return batch.map(mockEmbed);
  if (cfg.provider === "transformers")
    return transformersEmbed(batch, cfg.model);

  const attempt = () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
    const gap = paceInterval(cfg);
    if (gap > 0) nextSlotAt = Date.now() + gap;
    return postEmbeddings(endpoint, cfg, batch, ac.signal).finally(() =>
      clearTimeout(timer),
    );
  };

  // Hedge a SINGLE text and nothing larger. One text is a query embed, where a stalled request costs
  // somebody staring at a chat panel and a duplicate is worth the second call. A batch is bulk work
  // out of an ingest queue: nobody is waiting on any individual batch, so the duplicate buys nothing
  // at all and costs another request against a limit that counts requests. Gating on the batch size
  // rather than adding a setting means an operator cannot get it wrong and does not have to find it.
  const bulk = batch.length > 1;

  const once = () => {
    if (!cfg.hedgeMs || cfg.hedgeMs <= 0 || bulk || rateLimited())
      return attempt();
    const first = attempt();
    let hedgeTimer;
    const hedge = new Promise((resolve, reject) => {
      hedgeTimer = setTimeout(
        () => attempt().then(resolve, reject),
        cfg.hedgeMs,
      );
    });
    return Promise.race([first, hedge]).finally(() => clearTimeout(hedgeTimer));
  };

  let tries = 0;
  // Counted separately from `tries` because the two failures need different patience, in different
  // units. A timeout or a dropped connection is one request's bad luck and a handful of attempts
  // settles it; a rate limit is a property of the account for the next minute or more, so what
  // matters is how long we are willing to keep asking, not how many times.
  // NOT named rateLimited: that is the module-level "has the account been refused lately" guard, and
  // `once` closes over it. A local of the same name shadows it for the whole function and turns the
  // hedge check into a call on a number -- which only shows up when hedging is on, i.e. in production.
  let limitedTries = 0;
  let spentOnRateLimit = 0;
  /** Whether this batch has already had the full explanation, so it is given once and not per rung. */
  let advised = false;
  for (;;) {
    tries++;
    await awaitGate();
    try {
      return await once();
    } catch (err) {
      const isAbort = err?.name === "AbortError";
      // A TypeError from fetch is a dropped connection rather than a refusal, and passes with time.
      const retryable = isAbort || err?.retryable || err?.name === "TypeError";
      if (!retryable) throw err;

      const limited = err?.providerStatus === 429;
      if (limited) limitedTries++;
      else if (tries > cfg.maxRetries) throw err;

      const wait = err?.retryAfter
        ? err.retryAfter * 1000
        : limited
          ? // A reset header, when the provider sent one, beats any schedule we could invent.
            // Otherwise DOUBLE from the MEASURED scale of a momentary refusal (see rateLimitWaitMs):
            // 250ms, 0.5s, 1s, 2s, 4s, 8s, 16s, all inside the 45s hold. Probing the short wait first
            // is what the evidence asks for — the measured refusal cleared on the first 250ms retry —
            // and doubling still reaches a genuinely long wait within the same hold if this one turns
            // out to be a real window rather than a blip. Jitter is proportional rather than a flat
            // second: the gate already serialises this process, so it only exists to de-correlate
            // several services sharing one key, and a flat term would dominate the short waits.
            err.resetWaitMs ||
            Math.min(120_000, cfg.rateLimitWaitMs * 2 ** (limitedTries - 1)) *
              (1 + Math.random() * 0.1)
          : Math.min(60_000, 2 ** tries * 1000) + Math.random() * 1000;

      if (limited) {
        // Whether to keep holding THIS request open, which is a different question from whether the
        // work is worth retrying. See rateLimitBudgetMs: the caller owns the long wait.
        if (spentOnRateLimit + wait > cfg.rateLimitBudgetMs) {
          pauseAll(wait, cfg);
          err.message +=
            ` — handing back after ${dur(spentOnRateLimit)} so the caller can wait` +
            ` visibly and resume` +
            (adaptivePaceMs > 0
              ? `; the service will stay paced at ${dur(adaptivePaceMs)} between requests`
              : "");
          throw err;
        }
        spentOnRateLimit += wait;
        // Naming the limiter matters more than the numbers: an upstream refusal relayed through
        // OpenRouter looks identical to OpenRouter's own limit in a log, and the remedies are
        // opposite. Without this the operator's first move is to buy credits that cannot help.
        const who =
          err.limiter === "unknown"
            ? ""
            : ` [${err.limiter} limit${err.limiterDetail ? `: ${err.limiterDetail}` : ""}]`;
        // Routine until it is not. See REFUSAL_NOISE_MS: a blip we retry away is an `info` line and
        // no advice, because there is nothing for anybody to do about it, while a batch that has been
        // refused for seconds is the operator's problem and gets the whole explanation once.
        const noisy = spentOnRateLimit >= REFUSAL_NOISE_MS;
        const size = err.batchSize ?? batch.length;
        // The model and the size are what make the advice checkable: a per-request override means the
        // env default is not necessarily what was refused, and one text versus sixty-four is the
        // difference between "ask more slowly" and "there is nothing left to slow down".
        const line =
          `embed rate-limited${who} on ${cfg.model} (${size} text${size === 1 ? "" : "s"}), ` +
          `retrying in ${dur(wait)} (attempt ${limitedTries}, ${dur(spentOnRateLimit)} of ` +
          `${dur(cfg.rateLimitBudgetMs)} hold): ${err.message}`;
        if (noisy) log.warn(line);
        else log.info(line);
        if (noisy && !advised) {
          advised = true;
          if (err.limiterAdvice)
            log.warn(`embed rate limit: ${err.limiterAdvice}`);
          if (cfg.provider === "openrouter") {
            const note = await routingNote(cfg.model);
            if (note) log.warn(`embed rate limit: ${note}`);
          }
        }
        // Only a rate limit is everyone's problem. Stalling every other request for one timeout
        // would throw away throughput for nothing.
        pauseAll(wait, cfg);
        if (adaptivePaceMs > 0) {
          log.info(`embed pacing now ${dur(adaptivePaceMs)} between requests`);
        }
      } else {
        log.warn(
          `embed retry ${tries}/${cfg.maxRetries} in ${dur(wait)}: ${err.message}`,
        );
      }
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
 * Group texts into requests: at most `batchSize` items and at most `maxCharsPerRequest` characters.
 *
 * The character cap is what makes the batch size safe to raise. Requests are the scarce resource
 * against a per-minute limit, so a bigger batch is the strongest lever there is -- but the same
 * change can push one request past the provider's own length limit, and a 400 on every batch is a
 * worse failure than a slow run. An item longer than the cap on its own is still sent alone: the
 * provider's verdict on it is information, and silently dropping a document is not.
 * @returns {number[][]} index groups, in order
 */
export function planBatches(texts, cfg) {
  const groups = [];
  let current = [];
  let chars = 0;
  for (let i = 0; i < texts.length; i++) {
    const size = String(texts[i] ?? "").length;
    if (
      current.length > 0 &&
      (current.length >= cfg.batchSize || chars + size > cfg.maxCharsPerRequest)
    ) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    current.push(i);
    chars += size;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Group identical texts so each distinct wording is embedded once.
 *
 * The corpus miner's largest single efficiency was this and nothing cleverer: 4,661 SRD features
 * reduced to 1,387 distinct wordings, one trait's text shared by 270 creatures, because system
 * content is templated rather than written out per creature. Paying for that redundancy buys
 * literally nothing here -- a vector store row is identified by the hash of its text, so identical
 * chunks were always going to be one row.
 *
 * Keyed on the exact string, never on `contentHash`: that is a 32-bit FNV-1a, and at corpus scale the
 * birthday bound makes a collision near-certain, so hashing here would eventually hand one chunk
 * another chunk's vector -- silently, and undetectably from the outside.
 * @returns {{unique: string[], slotOf: number[]}} texts to embed, and which of them each input wants
 */
export function groupIdentical(texts) {
  const slotFor = new Map();
  const unique = [];
  const slotOf = new Array(texts.length);
  for (let i = 0; i < texts.length; i++) {
    const t = String(texts[i] ?? "");
    let slot = slotFor.get(t);
    if (slot === undefined) {
      slot = unique.length;
      slotFor.set(t, slot);
      unique.push(texts[i]);
    }
    slotOf[i] = slot;
  }
  return { unique, slotOf };
}

/**
 * Embed an array of texts. Batches by cfg.batchSize; on a batch failure, retries
 * that batch one item at a time so a single bad/stuck item can't sink the run.
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(texts, reqEmbed) {
  const cfg = resolveEmbedConfig(reqEmbed);
  const modelOptional =
    cfg.provider === "mock" || cfg.provider === "transformers";
  if (!modelOptional && !cfg.model) {
    throw new HttpError(400, "embedding model is required");
  }
  const endpoint = endpointFor(cfg);

  const { unique, slotOf } = groupIdentical(texts);
  if (unique.length < texts.length) {
    log.info(
      `embed: ${texts.length} texts are ${unique.length} distinct wordings (${texts.length - unique.length} reused)`,
    );
  }

  const out = new Array(unique.length);
  for (const idxs of planBatches(unique, cfg)) {
    const batch = idxs.map((i) => unique[i]);
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
      log.warn(
        `embed batch failed (${err.message}); retrying ${batch.length} items individually`,
      );
      for (let k = 0; k < batch.length; k++) {
        out[idxs[k]] = (await embedBatchHedged(endpoint, cfg, [batch[k]]))[0];
      }
    }
  }
  assertValidVectors(out, cfg.model || cfg.provider);
  // Duplicate slots share the vector object rather than copying it. Nothing downstream mutates a
  // vector, and a copy would mean another few thousand floats per repeat for no benefit.
  return slotOf.map((slot) => out[slot]);
}
