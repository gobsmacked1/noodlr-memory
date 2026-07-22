import { test } from "node:test";
import assert from "node:assert/strict";
import { rerank, rerankMulti, bm25Scores, tokenize } from "../src/rerank.js";

test("tokenize lowercases, splits, drops stopwords", () => {
  assert.deepEqual(tokenize("The Vampire drinks BLOOD!"), ["vampire", "drinks", "blood"]);
});

test("bm25 rewards exact keyword overlap", () => {
  const q = tokenize("astarion blood");
  const docs = [tokenize("astarion drinks blood nightly"), tokenize("the tavern was warm")];
  const [a, b] = bm25Scores(q, docs);
  assert.ok(a > b, "keyword-matching doc scores higher");
  assert.equal(b, 0, "non-matching doc scores zero");
});

test("hybrid surfaces a keyword match the dense layer ranked low", () => {
  const cands = [
    { id: "noise1", text: "The tavern was warm and lively that evening", score: 0.78 },
    { id: "noise2", text: "A cloaked figure moved quietly through the shadows", score: 0.72 },
    { id: "noise3", text: "They spent the afternoon discussing travel plans", score: 0.69 },
    { id: "target", text: "Astarion feeds on blood to survive the curse", score: 0.34 },
    { id: "noise4", text: "Someone complained about the weather again", score: 0.31 },
  ];
  const query = "Why does Astarion need blood?";

  const denseIdx = [...cands].sort((a, b) => b.score - a.score).findIndex((c) => c.id === "target");
  const hybridIdx = rerank(query, cands).findIndex((c) => c.id === "target");

  assert.equal(denseIdx, 3, "dense-only ranks the target near the bottom");
  assert.ok(hybridIdx < denseIdx, `hybrid promotes the keyword match (was ${denseIdx}, now ${hybridIdx})`);
});

test("importance weighting breaks ties toward more important events", () => {
  const cands = [
    { id: "lo", text: "the party rested at camp", score: 0.5, metadata: { importance: 2 } },
    { id: "hi", text: "the party rested at camp", score: 0.5, metadata: { importance: 9 } },
  ];
  const hits = rerank("party rested at camp", cands);
  assert.equal(hits[0].id, "hi");
});

test("recency weighting favors newer events on a tie", () => {
  const now = Date.now();
  const day = 86400000;
  const cands = [
    { id: "old", text: "a deal was struck with the guild", score: 0.5, metadata: { ts: now - 120 * day } },
    { id: "new", text: "a deal was struck with the guild", score: 0.5, metadata: { ts: now - 1 * day } },
  ];
  const hits = rerank("deal with the guild", cands, { now });
  assert.equal(hits[0].id, "new");
});

test("rerank is rerankMulti with a single list (back-compat)", () => {
  const cands = [
    { id: "a", text: "the dragon guards the ruby crown", score: 0.6 },
    { id: "b", text: "a pumpkin soup recipe with nutmeg", score: 0.3 },
  ];
  const single = rerank("dragon ruby crown", cands);
  const multi = rerankMulti(["dragon ruby crown"], [cands]);
  assert.deepEqual(
    multi.map((h) => [h.id, h.finalScore]),
    single.map((h) => [h.id, h.finalScore]),
    "single-list rerankMulti matches rerank exactly",
  );
});

test("multi-list RRF fuses sub-queries and dedups a shared doc", () => {
  // Two sub-queries, each with its own ranked list. `shared` appears in both
  // (different collections would be distinct; here same id => one merged doc)
  // and should accumulate RRF mass from both, ranking it top.
  const listA = [
    { id: "shared", collection: "lore", text: "Astarion is a vampire spawn seeking freedom", score: 0.7 },
    { id: "onlyA", collection: "lore", text: "the tavern in Baldur's Gate was crowded", score: 0.65 },
  ];
  const listB = [
    { id: "shared", collection: "lore", text: "Astarion is a vampire spawn seeking freedom", score: 0.72 },
    { id: "onlyB", collection: "lore", text: "Cazador is the vampire lord who enslaved him", score: 0.6 },
  ];
  const hits = rerankMulti(
    ["who is Astarion", "what is Astarion's relationship to Cazador"],
    [listA, listB],
  );
  const ids = hits.map((h) => h.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate docs after fusion");
  assert.equal(ids[0], "shared", "doc surfaced by both sub-queries ranks first");
  assert.deepEqual(new Set(ids), new Set(["shared", "onlyA", "onlyB"]), "union of both lists returned");
});

test("entity soft-boost promotes a matching entity on a tie", () => {
  const cands = [
    { id: "noent", text: "the party made camp near the river", score: 0.5, metadata: { entities: ["river"] } },
    { id: "match", text: "the party made camp near the river", score: 0.5, metadata: { entities: ["Astarion", "river"] } },
  ];
  const hits = rerank("camp by the river", cands, { entities: ["astarion"] });
  assert.equal(hits[0].id, "match", "candidate whose entities include the query entity wins the tie");
});
