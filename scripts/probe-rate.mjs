#!/usr/bin/env node
// Measures what an embedding provider will actually tolerate, so the throttling question stops being
// answered by inference.
//
// Every wait and every pacing default in this service was sized for a MODEL of the limit rather than
// a measurement of it, and the model was wrong: 1.1.1 through 1.2.1 assumed a per-minute window on
// the account (hence 20-second waits and a learned pace), while an operator's OpenRouter generation
// log showed a single-text embed returning 200 and another refused about one second later. Those two
// pictures call for opposite responses — park for twenty seconds, or retry almost immediately — and
// nothing in a 429 body distinguishes them. This script does.
//
// It talks to the provider DIRECTLY, deliberately bypassing embeddings.js: the gate, the retries, the
// hedge and the pacing are exactly what would corrupt the measurement, because they exist to hide the
// behaviour being measured. What comes back is one line per request with its status and latency.
//
// -----------------------------------------------------------------------------------------------
// CONFIG (same variables as the service, so this measures YOUR configuration):
//   EMBED_PROVIDER   openrouter | custom          (default openrouter)
//   EMBED_MODEL      embedding model slug         (default perplexity/pplx-embed-v1-4b)
//   EMBED_BASE_URL   for provider=custom (OpenAI-compatible base, no /embeddings)
//   EMBED_API_KEY    the key. Required for openrouter.
//
// COMMANDS:
//   node scripts/probe-rate.mjs burst [n]            # n single-text requests back to back
//   node scripts/probe-rate.mjs paced <ms> [n]       # n single-text requests <ms> apart
//   node scripts/probe-rate.mjs sweep                # 0, 250, 500, 1000, 2000ms — finds the floor
//   node scripts/probe-rate.mjs recover              # provoke a 429, then retry at 0.25s .. 16s to
//                                                    # measure how long a refusal actually lasts
//   node scripts/probe-rate.mjs batch [n]            # 1 request of n texts vs n of 1, same work
//   node scripts/probe-rate.mjs routing              # how many providers can serve the model
//
// On the Foundry host, with the service's own environment:
//   cd /opt/noodlr-memory && set -a && . ./.env && set +a && node scripts/probe-rate.mjs sweep
//
// Reading it: `recover` is the one that decides EMBED_RATE_LIMIT_WAIT_MS. If a refusal clears at
// 0.25s or 1s, a twenty-second wait is spending the operator's patience for nothing. If nothing
// under 16s clears it, the limit really is window-shaped and the long waits were right after all.
// -----------------------------------------------------------------------------------------------

const provider = (process.env.EMBED_PROVIDER || "openrouter").toLowerCase();
const model = process.env.EMBED_MODEL || "perplexity/pplx-embed-v1-4b";
const apiKey = process.env.EMBED_API_KEY || "";
const baseUrl = process.env.EMBED_BASE_URL || "";

const endpoint =
  provider === "custom"
    ? `${baseUrl.replace(/\/+$/, "")}/embeddings`
    : "https://openrouter.ai/api/v1/embeddings";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Distinct text per request: an identical body could plausibly be served from a provider-side cache,
// which would measure the cache's tolerance rather than the model's.
let seq = 0;
const text = () =>
  `noodlr rate probe ${process.pid} #${++seq} ${Math.random().toString(36).slice(2)}`;

async function embed(inputs) {
  const started = Date.now();
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(provider === "openrouter"
          ? { "HTTP-Referer": "https://noodlr.app", "X-Title": "Noodlr Memory" }
          : {}),
      },
      body: JSON.stringify({ model, input: inputs }),
    });
    const ms = Date.now() - started;
    if (res.ok) {
      const json = await res.json().catch(() => ({}));
      const dims = json?.data?.[0]?.embedding?.length ?? null;
      return { ok: true, status: 200, ms, dims };
    }
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      ms,
      // The reset headers are the difference between OpenRouter's own limit on the key and an
      // upstream provider's capacity, and only the first is fixable from the account side.
      reset: res.headers.get("x-ratelimit-reset"),
      remaining: res.headers.get("x-ratelimit-remaining"),
      retryAfter: res.headers.get("retry-after"),
      body: body.slice(0, 200),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      body: String(err),
    };
  }
}

function line(i, r, extra = "") {
  const tag = r.ok ? "200" : r.status === 0 ? "ERR" : String(r.status);
  const detail = r.ok
    ? `dims=${r.dims ?? "?"}`
    : [
        r.retryAfter ? `retry-after=${r.retryAfter}` : "",
        r.remaining ? `remaining=${r.remaining}` : "",
        r.reset ? `reset=${r.reset}` : "",
        r.status === 429 && !r.reset && !r.remaining
          ? "no x-ratelimit-* → UPSTREAM"
          : "",
        r.body ? r.body.replace(/\s+/g, " ") : "",
      ]
        .filter(Boolean)
        .join("  ");
  console.log(
    `  ${String(i).padStart(3)}  ${tag}  ${String(r.ms).padStart(6)}ms  ${extra}${detail}`,
  );
}

function tally(results) {
  const ok = results.filter((r) => r.ok).length;
  const limited = results.filter((r) => r.status === 429).length;
  const other = results.length - ok - limited;
  const lat = results.filter((r) => r.ok).map((r) => r.ms);
  const median = lat.length
    ? lat.sort((a, b) => a - b)[Math.floor(lat.length / 2)]
    : null;
  console.log(
    `  => ${ok} ok, ${limited} rate-limited, ${other} other` +
      (median !== null ? `; median ok latency ${median}ms` : ""),
  );
  return { ok, limited, other };
}

async function burst(n) {
  console.log(`burst: ${n} single-text requests, no gap  (${model})`);
  const results = [];
  for (let i = 1; i <= n; i++) {
    const r = await embed([text()]);
    line(i, r);
    results.push(r);
  }
  return tally(results);
}

async function paced(gap, n) {
  console.log(`paced: ${n} single-text requests, ${gap}ms apart  (${model})`);
  const results = [];
  for (let i = 1; i <= n; i++) {
    if (i > 1) await sleep(gap);
    const r = await embed([text()]);
    line(i, r);
    results.push(r);
  }
  return tally(results);
}

async function sweep() {
  console.log(`sweep: finding the gap at which refusals stop  (${model})\n`);
  for (const gap of [0, 250, 500, 1000, 2000]) {
    const { limited } = await paced(gap, 6);
    console.log("");
    if (limited === 0) {
      console.log(
        `Clean at ${gap}ms between requests. That is the floor to set EMBED_MIN_INTERVAL_MS to, ` +
          `if you set it at all — and 0 means the provider never refused us.`,
      );
      return;
    }
    // Let whatever we just provoked clear before measuring the next rung, or the previous rung's
    // refusal is inherited and every gap looks equally bad.
    await sleep(15000);
  }
  console.log(
    "Refused at every gap up to 2s. Either the limit is very low, or the model's upstream capacity " +
      "is exhausted for reasons unrelated to your rate — run `routing` and try another model.",
  );
}

async function recover() {
  console.log(`recover: how long a refusal actually lasts  (${model})\n`);
  console.log("Provoking a refusal with a burst:");
  let hit = null;
  let at = 0;
  for (let i = 1; i <= 12; i++) {
    const r = await embed([text()]);
    line(i, r);
    if (r.status === 429) {
      hit = r;
      at = i;
      break;
    }
  }
  // WHICH request was refused answers a bigger question than how long it lasted, and it is free.
  // This process has sent nothing before its first call, so a refusal there cannot be a consequence
  // of our rate — it is the model's shared capacity — and every remedy shaped like "ask more slowly"
  // is answering a question the provider never asked.
  if (hit && at === 1)
    console.log(
      "\nRefused on the FIRST request from a cold process, having sent nothing before it. Your " +
        "request rate did not cause this and cannot fix it: leave EMBED_MIN_INTERVAL_MS and " +
        "EMBED_PACE_MAX_MS at 0, and treat the refusal as something to retry rather than to avoid.",
    );
  if (!hit) {
    console.log(
      "\nNo refusal in 12 back-to-back requests. Nothing here needs a wait at all: whatever you " +
        "saw was not this provider's rate limit under this configuration.",
    );
    return;
  }
  if (hit.retryAfter)
    console.log(
      `\nThe provider asked for ${hit.retryAfter}s. That always wins over any schedule.`,
    );
  console.log("\nRetrying after each wait (first success is the answer):");
  for (const wait of [250, 500, 1000, 2000, 4000, 8000, 16000]) {
    await sleep(wait);
    const r = await embed([text()]);
    line(wait, r, `after ${wait}ms  `);
    if (r.ok) {
      console.log(
        `\n=> Cleared after ${wait}ms. Set EMBED_RATE_LIMIT_WAIT_MS near ${wait} — the wait doubles ` +
          `from there, so it reaches a long wait quickly if a later refusal needs one.`,
      );
      return;
    }
  }
  console.log(
    "\n=> Still refused after 16s. This one is window-shaped: raise EMBED_RATE_LIMIT_WAIT_MS " +
      "towards 20000 and prefer larger EMBED_BATCH_SIZE so the same corpus is fewer requests.",
  );
}

async function batch(n) {
  console.log(
    `batch: ${n} texts as ONE request, then as ${n} requests  (${model})\n`,
  );
  const many = Array.from({ length: n }, () => text());
  const one = await embed(many);
  line(1, one, `1 request of ${n} texts  `);
  await sleep(3000);
  const results = [];
  for (let i = 1; i <= n; i++) {
    const r = await embed([text()]);
    results.push(r);
  }
  tally(results);
  console.log(
    "\nA limit that counts REQUESTS is why batching is the first lever: identical work, one call " +
      "instead of " +
      n +
      ". If the single batch succeeded and the loop was refused, that is the whole argument.",
  );
}

async function routing() {
  if (provider !== "openrouter") {
    console.log("routing only applies to OpenRouter.");
    return;
  }
  const url = `https://openrouter.ai/api/v1/models/${model}/endpoints`;
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`Could not read the catalogue (${res.status}).`);
    return;
  }
  const eps = (await res.json())?.data?.endpoints ?? [];
  console.log(`${model}: ${eps.length} provider endpoint(s)`);
  for (const e of eps)
    console.log(`  - ${e.provider_name} (ctx ${e.context_length})`);
  if (eps.length === 1)
    console.log(
      "\nONE provider means OpenRouter has nothing to fail over to, so that provider's own " +
        "saturation — caused by anyone's traffic, not only yours — reaches you as a 429 however " +
        "slowly you ask. A model with several providers absorbs the same event invisibly.",
    );
}

const [cmd, a, b] = process.argv.slice(2);
// `routing` reads the public catalogue and needs no key, and demanding one would send the operator
// hunting for a credential to answer a question that costs nothing.
if (provider === "openrouter" && !apiKey && cmd !== "routing") {
  console.error("EMBED_API_KEY is required for provider=openrouter.");
  process.exit(2);
}
try {
  switch (cmd) {
    case "burst":
      await burst(Number(a) || 12);
      break;
    case "paced":
      await paced(Number(a) || 1000, Number(b) || 8);
      break;
    case "sweep":
      await sweep();
      break;
    case "recover":
      await recover();
      break;
    case "batch":
      await batch(Number(a) || 16);
      break;
    case "routing":
      await routing();
      break;
    default:
      console.log(
        "usage: probe-rate.mjs burst [n] | paced <ms> [n] | sweep | recover | batch [n] | routing",
      );
      process.exit(1);
  }
} catch (err) {
  console.error(String(err));
  process.exit(1);
}
