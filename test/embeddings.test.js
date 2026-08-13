import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  embedTexts,
  planBatches,
  rateLimitState,
  resetRateLimitGate,
} from "../src/embeddings.js";

// The rate-limit path had no coverage at all, which is how it shipped as an amplifier: a 429 split
// one refused batch into batchSize more immediate requests and then threw anyway. Same lesson as the
// hybrid query bug -- the unit tests exercised the store directly and never the route that used it.

const realFetch = globalThis.fetch;

/**
 * OpenRouter relaying an UPSTREAM provider's refusal: the body is the provider's own JSON, nested
 * inside OpenRouter's and prefixed with the upstream status. Verbatim from a live run, because the
 * shape is the only thing distinguishing this from OpenRouter's own limit and the remedies differ.
 */
const RELAYED_429 = JSON.stringify({
  error: {
    message:
      'HTTP 429: {"error":{"message":"Rate limit exceeded, please try again later.","type":"request_rate_limit_exceeded","code":429}}',
    code: 429,
  },
});

/** A provider that refuses the first `fails` requests with 429, then answers normally. */
function stubProvider({
  fails = 0,
  retryAfter = null,
  dim = 4,
  headers = {},
  body = null,
} = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const input = JSON.parse(init.body).input;
    calls.push({ size: input.length, at: Date.now() });
    if (calls.length <= fails) {
      return new Response(
        body ??
          JSON.stringify({
            error: { message: "Rate limit exceeded", code: 429 },
          }),
        {
          status: 429,
          headers: {
            ...headers,
            ...(retryAfter === null
              ? {}
              : { "retry-after": String(retryAfter) }),
          },
        },
      );
    }
    return new Response(
      JSON.stringify({
        data: input.map((_, index) => ({
          index,
          embedding: new Array(dim).fill(0.5),
        })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return calls;
}

const cfg = {
  provider: "custom",
  baseUrl: "https://example.invalid/v1",
  model: "test-embed",
  apiKey: "k",
  batchSize: 4,
  // Hedging off by default here: it is a latency feature and would double every count below.
  hedgeMs: 0,
  timeoutMs: 5000,
  // The shipped defaults wait 20s on the first 429 and then pace every later request, both of which
  // are the point (see config.js) and neither of which belongs in a test's wall clock. Every test
  // that means to exercise the sizing of those waits sets them explicitly.
  rateLimitWaitMs: 10,
  paceStepMs: 0,
};

beforeEach(() => {
  resetRateLimitGate();
  globalThis.fetch = realFetch;
});

test("a transient 429 is retried rather than failing the ingest", async () => {
  const calls = stubProvider({ fails: 1, retryAfter: 0 });
  const vecs = await embedTexts(["a", "b"], { ...cfg, maxRetries: 3 });
  assert.equal(vecs.length, 2);
  assert.equal(calls.length, 2, "one refusal, one successful retry");
});

test("Retry-After is honoured when the provider sends one", async () => {
  const calls = stubProvider({ fails: 1, retryAfter: 1 });
  const started = Date.now();
  await embedTexts(["a"], { ...cfg, maxRetries: 3 });
  const waited = Date.now() - started;
  assert.ok(waited >= 950, `expected to wait ~1s, waited ${waited}ms`);
  assert.equal(calls.length, 2);
});

test("a persistent 429 is NOT split into one request per item", async () => {
  // The regression. With batchSize 4 and the old fallback, exhausting retries on the batch fired
  // four more requests immediately -- at an endpoint that had just said stop -- and then threw
  // from the first of them anyway.
  const calls = stubProvider({ fails: 99, retryAfter: 0 });
  await assert.rejects(
    () =>
      embedTexts(["a", "b", "c", "d"], {
        ...cfg,
        maxRetries: 2,
        rateLimitWaitMs: 100,
        rateLimitBudgetMs: 250,
      }),
    /429/,
  );
  assert.equal(
    calls.length,
    2,
    "the attempt plus what the patience budget affords, no fan-out",
  );
});

test("a rate limit is given time, not a handful of attempts", async () => {
  // What made a compendium ingest unfinishable: five retries of exponential backoff from 2s spend
  // themselves inside a single per-minute window, so the run died about a minute in with the
  // provider still refusing. maxRetries is deliberately 1 here -- it must not govern a 429 at all.
  const calls = stubProvider({ fails: 4, retryAfter: 0 });
  const vecs = await embedTexts(["a"], {
    ...cfg,
    maxRetries: 1,
    rateLimitWaitMs: 5,
    rateLimitBudgetMs: 5000,
  });
  assert.equal(vecs.length, 1);
  assert.equal(
    calls.length,
    5,
    "four refusals then the answer, on the time budget",
  );
});

test("the patience budget is finite, so a permanently throttled key still reports", async () => {
  const calls = stubProvider({ fails: 99, retryAfter: 0 });
  await assert.rejects(
    () =>
      embedTexts(["a"], {
        ...cfg,
        rateLimitWaitMs: 50,
        rateLimitBudgetMs: 120,
      }),
    /429/,
  );
  // 50 then 100 exceeds 120, so it stops after the first wait rather than asking forever.
  assert.equal(calls.length, 2);
});

test("one 429 paces every later request, instead of bursting into the next window", async () => {
  // A run that waits out a limit and then resumes at full speed hits the same wall every window.
  const calls = stubProvider({ fails: 1, retryAfter: 0 });
  await embedTexts(["a", "b", "c"], {
    ...cfg,
    batchSize: 1,
    rateLimitWaitMs: 5,
    paceStepMs: 120,
    paceMaxMs: 500,
  });
  assert.equal(
    calls.length,
    4,
    "one refusal, its retry, then the two remaining batches",
  );
  assert.equal(
    rateLimitState().pacingMs,
    120,
    "the learned gap survives the batch",
  );
  const gap = calls[3].at - calls[2].at;
  assert.ok(
    gap >= 110,
    `expected the learned pacing between requests, saw ${gap}ms`,
  );
});

test("a 429 is survived with hedging ON, which is the shipped default", async () => {
  // Every other test here runs with hedgeMs 0 so the request counts mean something, and that left the
  // production configuration untested: the hedge path is the one that consults the module-level
  // rate-limit guard, so a mistake there fails only where nobody is looking.
  const calls = stubProvider({ fails: 1, retryAfter: 0 });
  const vecs = await embedTexts(["a"], { ...cfg, hedgeMs: 20_000 });
  assert.equal(vecs.length, 1);
  assert.equal(
    calls.length,
    2,
    "the refusal and its retry, with no hedge fired",
  );
});

test("a batch is split on characters as well as count, so raising batchSize stays safe", () => {
  const plan = planBatches(["a".repeat(60), "b".repeat(60), "c"], {
    batchSize: 16,
    maxCharsPerRequest: 100,
  });
  assert.deepEqual(plan, [[0], [1, 2]]);
});

test("an item longer than the character cap is sent alone rather than dropped", () => {
  const plan = planBatches(["x".repeat(500), "y"], {
    batchSize: 16,
    maxCharsPerRequest: 100,
  });
  assert.deepEqual(plan, [[0], [1]], "every index is still accounted for");
});

test("a poison item still gets the per-item split", async () => {
  // The split has a real job and must survive the fix: a 400 on the whole batch is retried
  // item by item so one bad document cannot sink the good ones beside it.
  let batchCalls = 0;
  globalThis.fetch = async (url, init) => {
    const input = JSON.parse(init.body).input;
    batchCalls++;
    if (input.length > 1) {
      return new Response(JSON.stringify({ error: "too long" }), {
        status: 400,
      });
    }
    return new Response(
      JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3, 0.4] }] }),
      { status: 200 },
    );
  };
  const vecs = await embedTexts(["a", "b"], { ...cfg, maxRetries: 1 });
  assert.equal(vecs.length, 2);
  assert.equal(batchCalls, 3, "the failed batch plus one request per item");
});

test("handing a 429 back to the caller leaves the learned pacing in place", async () => {
  // The hold is short on purpose (the caller owns the long wait and has the progress bar), which puts
  // the whole weight of not re-bursting on the gate SURVIVING the throw. Reset the pace on the way
  // out and the caller's retry arrives at full speed into the same wall, which is the stall-burst
  // cycle the adaptation exists to stop -- and it would look exactly like the adaptation not working.
  const calls = stubProvider({ fails: 99, body: RELAYED_429 });
  await assert.rejects(
    () =>
      embedTexts(["a"], {
        ...cfg,
        rateLimitWaitMs: 20,
        rateLimitBudgetMs: 30,
        paceStepMs: 40,
        paceMaxMs: 500,
      }),
    /429/,
  );
  assert.equal(
    calls.length,
    2,
    "one refusal, one retry inside the hold, then hand back",
  );
  assert.ok(
    rateLimitState().pacingMs >= 40,
    "the pace learned from the refusals outlives the throw",
  );
  assert.ok(
    rateLimitState().pausedForMs > 0,
    "and the process is still holding the door shut",
  );
});

test("X-RateLimit-Reset is used as the wait when there is no Retry-After", async () => {
  // Free information we were discarding. OpenRouter sends these headers only when the limit is its
  // OWN rather than an upstream provider's, so their presence is also what tells the two apart.
  const calls = stubProvider({
    fails: 1,
    headers: {
      "x-ratelimit-limit": "20",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Date.now() + 1000),
    },
  });
  const started = Date.now();
  await embedTexts(["a"], { ...cfg, rateLimitWaitMs: 60_000 });
  const waited = Date.now() - started;
  assert.equal(calls.length, 2);
  assert.ok(
    waited >= 900,
    `expected the reset header's ~1s, waited ${waited}ms`,
  );
  assert.ok(
    waited < 10_000,
    "and not the 60s schedule it would have invented instead",
  );
});

test("a 401 is not retried, because it will never pass", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: "no key" }), { status: 401 });
  };
  await assert.rejects(
    () => embedTexts(["a"], { ...cfg, maxRetries: 5 }),
    /401/,
  );
  // One batch attempt, then the per-item split tries the single item once more and gives up.
  assert.ok(
    calls <= 2,
    `expected no retry storm on a permanent failure, saw ${calls} calls`,
  );
});
