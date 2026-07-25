import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { LanceStore } from "../src/stores/lance-store.js";
import { embedTexts } from "../src/embeddings.js";
import { chunkDocument } from "../src/chunker.js";

// Round-trip against the embedded LanceDB backend using the deterministic mock embedder.
// Skips cleanly if the native @lancedb/lancedb binary isn't installed for this platform,
// so the suite still runs in minimal environments.
test("lancedb + mock embeddings round-trip", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "noodlr-lance-"));
  try {
    const store = new LanceStore({ lancedbUri: join(dir, "lancedb") });
    try {
      await store.init();
    } catch (err) {
      t.skip(`@lancedb/lancedb not available: ${err.message}`);
      return;
    }

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

    // Re-upsert the same chunks must not duplicate rows (dedup by id/hash).
    await store.upsert("lore", items.map((c, i) => ({ ...c, vector: vectors[i] })));
    assert.equal((await store.listHashes("lore")).length, items.length, "re-upsert is idempotent");

    // Regression: a bad topK (NaN/0/negative) must not crash search ("k must be positive") nor
    // silently return zero hits. This is the failure the query route hit via a mis-argued clampInt.
    for (const badK of [NaN, 0, -3]) {
      const guarded = await store.query("lore", qvec, badK, 0);
      assert.ok(guarded.length > 0, `store.query survives topK=${badK}`);
    }

    await store.purge("lore");
    assert.equal((await store.listHashes("lore")).length, 0, "purge empties the collection");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
