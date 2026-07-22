import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkDocument, segment } from "../src/chunker.js";

test("prose is split into overlapping chunks", () => {
  const para = "Lorem ipsum dolor sit amet. ".repeat(60); // ~1680 chars
  const text = [para, para, para].join("\n\n"); // ~5000 chars
  const chunks = chunkDocument({ text }, { targetChars: 2000, overlapChars: 300 });
  assert.ok(chunks.length >= 2, "should produce multiple chunks");
  for (const c of chunks) {
    assert.ok(c.text.length <= 3200, "chunk under hard cap");
    assert.equal(c.metadata.kind, "prose");
    assert.ok(Number.isFinite(c.hash));
  }
  assert.deepEqual(
    chunks.map((c) => c.index),
    chunks.map((_, i) => i),
    "indexes are sequential",
  );
});

test("a markdown table is detected and kept atomic", () => {
  const text = [
    "## Wild Magic Surge",
    "Roll on the table when you cast a spell.",
    "",
    "| d100 | Effect |",
    "| --- | --- |",
    "| 01-02 | Roll on this table at the start of each turn. |",
    "| 03-04 | A creature appears. |",
    "| 05-06 | You cast fireball. |",
    "",
    "The effect lasts one minute.",
  ].join("\n");

  const segs = segment(text);
  const tableSegs = segs.filter((s) => s.type === "table");
  assert.equal(tableSegs.length, 1, "exactly one table segment");
  assert.match(tableSegs[0].text, /d100/);
  assert.equal(tableSegs[0].heading, "Wild Magic Surge", "table carries its heading");

  const chunks = chunkDocument({ text }, { targetChars: 4000, overlapChars: 200 });
  const tableChunk = chunks.find((c) => c.metadata.kind === "table");
  assert.ok(tableChunk, "produced a table chunk");
  // All three data rows survive in the same chunk (not split).
  assert.match(tableChunk.text, /01-02/);
  assert.match(tableChunk.text, /05-06/);
});

test("a document explicitly flagged as a table is never split", () => {
  const bigTable = "| n | v |\n| --- | --- |\n" + Array.from({ length: 500 }, (_, i) => `| ${i} | val${i} |`).join("\n");
  const chunks = chunkDocument({ text: bigTable, kind: "table" }, { targetChars: 500 });
  assert.equal(chunks.length, 1, "kind:table stays a single chunk regardless of size");
  assert.equal(chunks[0].metadata.kind, "table");
});
