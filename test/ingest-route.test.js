import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import { VectraStore } from "../src/stores/vectra-store.js";
import { createRouter } from "../src/routes/vectors.js";

// The /ingest ROUTE, over HTTP, against a real store. Unit tests that exercised the store directly
// are what let "k must be positive" hide in the query route for weeks, and the skip-what-is-stored
// logic lives here rather than in embeddings.js, so it needs the same treatment.

async function withService(fn) {
  const dir = await mkdtemp(join(tmpdir(), "noodlr-route-"));
  const store = new VectraStore({ dataDir: dir });
  await store.init();
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.use("/v1", createRouter(store));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const post = async (path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  try {
    await fn({ post, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

const embed = { provider: "mock" };

test("re-ingesting a document does not pay to embed it again", async () => {
  await withService(async ({ post, store }) => {
    const documents = [
      { text: "The rogue Vex hid a silver dagger under the floorboards." },
      { text: "The dragon Karastyx hoards gold beneath the Sunless Citadel." },
    ];

    const first = await post("/ingest", { collection: "docs", documents, embed });
    assert.equal(first.status, 200);
    assert.ok(first.json.inserted > 0, "the first pass stores everything");
    assert.equal(first.json.skipped, 0);
    const stored = first.json.inserted;

    // This is a resumed or retried pack arriving a second time. A store row is identified by the
    // hash of its text, so every one of these chunks already exists with that exact vector: paying
    // the provider again would produce identical numbers.
    const second = await post("/ingest", { collection: "docs", documents, embed });
    assert.equal(second.json.inserted, 0, "nothing new to embed");
    assert.equal(second.json.alreadyStored, stored);
    assert.equal(second.json.chunks, first.json.chunks, "still reports what it was given");

    assert.equal(
      (await store.listHashes("docs")).length,
      stored,
      "and no duplicate rows were added",
    );
  });
});

test("a repeated chunk inside one request becomes one row", async () => {
  await withService(async ({ post, store }) => {
    // Worse than merely wasteful before: an upsert deletes by id and then adds, which does not
    // deduplicate within the batch, so identical chunks became several rows sharing one id --
    // individually undeletable and crowding each other out of a top-k.
    const text = "Pack Tactics. The creature has Advantage on an attack roll.";
    const documents = [{ text }, { text }, { text }];

    const res = await post("/ingest", { collection: "docs", documents, embed });
    assert.equal(res.json.inserted, 1);
    assert.equal(res.json.repeats, 2);
    assert.equal((await store.listHashes("docs")).length, 1);
  });
});

test("a reset silo is ingested from scratch, not skipped from a stale cache", async () => {
  await withService(async ({ post, store }) => {
    const documents = [{ text: "A recipe for pumpkin soup: simmer squash and cream." }];
    const first = await post("/ingest", { collection: "docs", documents, embed });
    assert.ok(first.json.inserted > 0);

    await post("/purge", { collection: "docs" });
    assert.equal((await store.listHashes("docs")).length, 0);

    // The whole point of resetting a silo is to repopulate it. A cache that survived the purge would
    // report success and store nothing, which is indistinguishable from the reset having failed.
    const again = await post("/ingest", { collection: "docs", documents, embed });
    assert.equal(again.json.inserted, first.json.inserted);
    assert.equal(again.json.skipped, 0);
  });
});

test("/insert always writes, because it is how a memory is retracted", async () => {
  await withService(async ({ post, store }) => {
    const text = "The duke is loyal to the crown.";
    const original = await post("/insert", {
      collection: "docs",
      items: [{ text, metadata: { importance: 8 } }],
      embed,
    });
    assert.equal(original.json.inserted, 1);

    // Retraction is delete + re-insert of the SAME text with different metadata: there is no
    // update-metadata endpoint. Skipping it as already-stored would leave the row exactly as it was
    // while reporting success, so a GM's deliberate retraction would silently not happen.
    const retracted = await post("/insert", {
      collection: "docs",
      items: [{ text, metadata: { importance: 8, retracted: true } }],
      embed,
    });
    assert.equal(retracted.json.inserted, 1, "the write is not skipped");
    assert.equal((await store.listHashes("docs")).length, 1, "and it replaced rather than added");
  });
});
