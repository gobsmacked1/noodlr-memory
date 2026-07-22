import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { VectraStore } from "../src/stores/vectra-store.js";
import { embedTexts } from "../src/embeddings.js";
import { chunkDocument } from "../src/chunker.js";
import { rerankMulti } from "../src/rerank.js";

// Full insert -> query round-trip against the file-based store using the
// deterministic mock embedder (no network). Validates the store plumbing and
// that semantically-closer text ranks above unrelated text.
test("vectra + mock embeddings round-trip retrieves the relevant chunk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noodlr-mem-"));
  try {
    const store = new VectraStore({ dataDir: dir });
    await store.init();

    const docs = [
      { text: "The rogue Vex hid a silver dagger under the floorboards of the tavern in Neverwinter." },
      { text: "A recipe for pumpkin soup: simmer squash, cream, and nutmeg for twenty minutes." },
      { text: "The dragon Karastyx hoards gold beneath the Sunless Citadel and guards a ruby crown." },
    ];
    const items = [];
    for (const d of docs) for (const c of chunkDocument(d)) items.push(c);

    const vectors = await embedTexts(items.map((i) => i.text), { provider: "mock" });
    await store.upsert("lore", items.map((c, i) => ({ ...c, vector: vectors[i] })));

    const [qvec] = await embedTexts(["Where did Vex hide the silver dagger?"], { provider: "mock" });
    const hits = await store.query("lore", qvec, 3, 0);

    assert.ok(hits.length > 0, "returns hits");
    assert.match(hits[0].text, /Vex/, "most relevant hit is the dagger/Vex chunk");
    assert.ok(hits[0].score >= hits[hits.length - 1].score, "sorted by descending score");

    const hashes = await store.listHashes("lore");
    assert.equal(hashes.length, items.length, "all chunks listed");

    await store.purge("lore");
    assert.equal((await store.listHashes("lore")).length, 0, "purge empties the collection");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Agent-Mode path: two distinct sub-queries, each gathering its own candidate
// list from the store, fused via rerankMulti. Proves the fused result unions
// both topics and dedups chunks any sub-query surfaced more than once.
test("multi-query fusion unions distinct topics and dedups", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noodlr-mem-"));
  try {
    const store = new VectraStore({ dataDir: dir });
    await store.init();

    const docs = [
      { text: "The rogue Vex hid a silver dagger under the floorboards of the tavern in Neverwinter." },
      { text: "The dragon Karastyx hoards gold beneath the Sunless Citadel and guards a ruby crown." },
      { text: "A recipe for pumpkin soup: simmer squash, cream, and nutmeg for twenty minutes." },
    ];
    const items = [];
    for (const d of docs) for (const c of chunkDocument(d)) items.push(c);
    const vectors = await embedTexts(items.map((i) => i.text), { provider: "mock" });
    await store.upsert("lore", items.map((c, i) => ({ ...c, vector: vectors[i] })));

    const subqueries = ["Where did Vex hide the dagger?", "What does the dragon Karastyx guard?"];
    const qvecs = await embedTexts(subqueries, { provider: "mock" });
    const candidateLists = [];
    for (const qvec of qvecs) {
      const found = await store.query("lore", qvec, 5, 0);
      candidateLists.push(found.map((h) => ({ collection: "lore", ...h })));
    }

    const hits = rerankMulti(subqueries, candidateLists, {});
    const ids = hits.map((h) => h.id);
    assert.equal(new Set(ids).size, ids.length, "no duplicate chunks after fusion");
    assert.ok(hits.some((h) => /Vex/.test(h.text)), "surfaces the dagger/Vex topic");
    assert.ok(hits.some((h) => /Karastyx/.test(h.text)), "surfaces the dragon/Karastyx topic");

    await store.purge("lore");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
