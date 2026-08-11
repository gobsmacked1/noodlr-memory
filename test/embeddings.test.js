import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { embedTexts, resetRateLimitGate } from "../src/embeddings.js";

// The rate-limit path had no coverage at all, which is how it shipped as an amplifier: a 429 split
// one refused batch into batchSize more immediate requests and then threw anyway. Same lesson as the
// hybrid query bug -- the unit tests exercised the store directly and never the route that used it.

const realFetch = globalThis.fetch;

/** A provider that refuses the first `fails` requests with 429, then answers normally. */
function stubProvider({ fails = 0, retryAfter = null, dim = 4 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const input = JSON.parse(init.body).input;
    calls.push({ size: input.length, at: Date.now() });
    if (calls.length <= fails) {
      return new Response(
        JSON.stringify({ error: { message: "Rate limit exceeded", code: 429 } }),
        {
          status: 429,
          headers: retryAfter === null ? {} : { "retry-after": String(retryAfter) },
        },
      );
    }
    return new Response(
      JSON.stringify({
        data: input.map((_, index) => ({ index, embedding: new Array(dim).fill(0.5) })),
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
    () => embedTexts(["a", "b", "c", "d"], { ...cfg, maxRetries: 2 }),
    /429/,
  );
  assert.equal(calls.length, 3, "one attempt plus maxRetries, and no per-item fan-out");
});

test("a poison item still gets the per-item split", async () => {
  // The split has a real job and must survive the fix: a 400 on the whole batch is retried
  // item by item so one bad document cannot sink the good ones beside it.
  let batchCalls = 0;
  globalThis.fetch = async (url, init) => {
    const input = JSON.parse(init.body).input;
    batchCalls++;
    if (input.length > 1) {
      return new Response(JSON.stringify({ error: "too long" }), { status: 400 });
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

test("a 401 is not retried, because it will never pass", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: "no key" }), { status: 401 });
  };
  await assert.rejects(() => embedTexts(["a"], { ...cfg, maxRetries: 5 }), /401/);
  // One batch attempt, then the per-item split tries the single item once more and gives up.
  assert.ok(calls <= 2, `expected no retry storm on a permanent failure, saw ${calls} calls`);
});
