import express from "express";
import { COLLECTIONS } from "../collections.js";
import { safeCollection, clampInt, clampFloat, HttpError } from "../sanitize.js";
import { embedTexts } from "../embeddings.js";
import { chunkDocument } from "../chunker.js";
import { rerankMulti } from "../rerank.js";

const MAX_TOPK = 100;
const MAX_DOCS_PER_REQUEST = 5000;
const MAX_SUBQUERIES = 8;
const MAX_ENTITIES = 32;

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * How many collections' hash sets to keep in memory at once.
 *
 * A hash set is a few megabytes for a large silo, and a service with a 512 MB heap should not be
 * holding all 35 at once because a GM ticked one pack per silo. An ingest works through one
 * collection at a time, so a small LRU keeps the hit rate near perfect for the case that matters.
 */
const KNOWN_CACHE_COLLECTIONS = 8;

export function createRouter(store) {
  const router = express.Router();

  /**
   * Which chunk hashes each collection already holds.
   *
   * Cached because the alternative is a full column scan per request, and the module sends a
   * compendium 25 documents at a time -- so a 5,000-document pack would scan the whole table 200
   * times. Our own writes are folded in rather than invalidating, since we know exactly what we
   * added; anything that REMOVES rows drops the entry and lets it rebuild.
   */
  const knownHashes = new Map();

  async function knownFor(collection) {
    const cached = knownHashes.get(collection);
    if (cached) {
      // Re-insert to mark it most-recently-used; Map iterates in insertion order.
      knownHashes.delete(collection);
      knownHashes.set(collection, cached);
      return cached;
    }
    const set = new Set(await store.listHashes(collection));
    knownHashes.set(collection, set);
    while (knownHashes.size > KNOWN_CACHE_COLLECTIONS) {
      knownHashes.delete(knownHashes.keys().next().value);
    }
    return set;
  }

  function rememberHashes(collection, items) {
    const set = knownHashes.get(collection);
    if (!set) return;
    for (const it of items) set.add(Number(it.hash));
  }

  function forgetHashes(collection) {
    if (collection === undefined) knownHashes.clear();
    else knownHashes.delete(collection);
  }

  /**
   * Reduce chunks to the ones actually worth embedding: no repeats, nothing already stored.
   *
   * Two savings, both of which were being paid for in full and neither of which bought anything.
   * A vector store row is identified by the hash of its text (see stores/base.js), so a chunk whose
   * hash is already present is a row that already exists with that exact vector -- re-embedding it
   * produces the same numbers at the provider's price. That is what makes a resumed or retried
   * ingest nearly free, which matters most on the run that was interrupted by a rate limit.
   * And a repeat WITHIN one request was worse than wasteful: `delete id IN (...)` followed by
   * `add(rows)` does not deduplicate inside the batch, so identical chunks became several rows
   * sharing one id -- undeletable individually and crowding each other out of a top-k.
   *
   * The hash is the right key here precisely because the store already treats it as identity; using
   * anything stricter would claim a distinction the storage layer cannot keep.
   *
   * `skipStored` is off for /insert, which is not "add this content" but "make this row be exactly
   * this": it is how the module retracts a bad memory and how the memory browser edits one, both of
   * which re-send the SAME text with different metadata. Skipping there would leave the row as it
   * was while reporting success, so a retraction would silently not happen.
   */
  async function freshItems(collection, items, { skipStored = true } = {}) {
    const stored = skipStored ? await knownFor(collection) : new Set();
    const seen = new Set();
    const fresh = [];
    let alreadyStored = 0;
    let repeats = 0;
    for (const it of items) {
      const hash = Number(it.hash);
      if (stored.has(hash)) {
        alreadyStored++;
        continue;
      }
      if (seen.has(hash)) {
        repeats++;
        continue;
      }
      seen.add(hash);
      fresh.push(it);
    }
    return { fresh, alreadyStored, repeats, skipped: alreadyStored + repeats };
  }

  router.get("/health", (_req, res) => res.json({ ok: true, backend: store.name }));

  router.get(
    "/collections",
    asyncHandler(async (_req, res) => {
      res.json({ collections: COLLECTIONS, stats: await store.stats() });
    }),
  );

  // Chunk + embed + upsert. The high-level ingestion entry point.
  router.post(
    "/ingest",
    asyncHandler(async (req, res) => {
      const collection = safeCollection(req.body.collection);
      const documents = Array.isArray(req.body.documents) ? req.body.documents : [];
      if (!documents.length) throw new HttpError(400, "documents[] required");
      if (documents.length > MAX_DOCS_PER_REQUEST) throw new HttpError(413, "too many documents");

      const chunkOpts = req.body.chunk ?? {};
      const items = [];
      for (const doc of documents) {
        if (typeof doc?.text !== "string" || !doc.text.trim()) continue;
        for (const chunk of chunkDocument(doc, chunkOpts)) {
          items.push(chunk);
        }
      }
      if (!items.length) return res.json({ inserted: 0, chunks: 0 });

      const { fresh, skipped, alreadyStored, repeats } = await freshItems(collection, items);
      if (!fresh.length) {
        return res.json({ inserted: 0, chunks: items.length, skipped, alreadyStored, repeats });
      }
      const vectors = await embedTexts(fresh.map((c) => c.text), req.body.embed);
      const withVectors = fresh.map((c, i) => ({ ...c, vector: vectors[i] }));
      await store.upsert(collection, withVectors);
      rememberHashes(collection, withVectors);
      res.json({
        inserted: withVectors.length,
        chunks: items.length,
        skipped,
        alreadyStored,
        repeats,
      });
    }),
  );

  // Ingest an uploaded document (TXT/MD/CSV/JSON parsed client-side into text;
  // PDF sent as base64 and parsed here via the optional pdf-parse dependency).
  router.post(
    "/ingest-file",
    asyncHandler(async (req, res) => {
      const collection = safeCollection(req.body.collection);
      const filename = String(req.body.filename || "document");
      const fileType = String(req.body.fileType || "text").toLowerCase();
      let text = "";

      if (fileType === "pdf") {
        let pdfParse;
        try {
          pdfParse = (await import("pdf-parse")).default;
        } catch {
          throw new HttpError(501, "PDF parsing requires the optional 'pdf-parse' dependency (run: npm i pdf-parse)");
        }
        const b64 = String(req.body.data || "");
        if (!b64) throw new HttpError(400, "data (base64) required for pdf");
        const buf = Buffer.from(b64, "base64");
        text = (await pdfParse(buf)).text || "";
      } else {
        text = String(req.body.text || "");
      }
      if (!text.trim()) throw new HttpError(400, "no extractable text");

      // Optional caller-supplied importance: the re-ranker treats a missing value as zero, so an
      // uploaded rulebook would otherwise rank below any chat capture that does carry one.
      const importance = Number(req.body.importance);
      const metadata = { sourceName: filename, sourceType: "upload" };
      if (Number.isFinite(importance)) {
        metadata.importance = Math.max(0, Math.min(10, importance));
      }
      const doc = { text, metadata };
      const chunks = chunkDocument(doc, req.body.chunk ?? {});
      if (!chunks.length) return res.json({ inserted: 0, chunks: 0 });
      const { fresh, skipped } = await freshItems(collection, chunks);
      if (!fresh.length) return res.json({ inserted: 0, chunks: chunks.length, skipped });
      const vectors = await embedTexts(fresh.map((c) => c.text), req.body.embed);
      const rows = fresh.map((c, i) => ({ ...c, vector: vectors[i] }));
      await store.upsert(collection, rows);
      rememberHashes(collection, rows);
      res.json({ inserted: rows.length, chunks: chunks.length, skipped });
    }),
  );

  // Embed + upsert pre-chunked items (caller controls chunking).
  router.post(
    "/insert",
    asyncHandler(async (req, res) => {
      const collection = safeCollection(req.body.collection);
      const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
      const items = rawItems
        .filter((it) => typeof it?.text === "string" && it.text.trim())
        .map((it, index) => ({
          text: it.text,
          index: Number.isFinite(it.index) ? it.index : index,
          hash: Number.isFinite(it.hash) ? it.hash : undefined,
          metadata: it.metadata && typeof it.metadata === "object" ? it.metadata : {},
        }));
      if (!items.length) return res.json({ inserted: 0 });

      const { contentHash } = await import("../sanitize.js");
      for (const it of items) if (it.hash === undefined) it.hash = contentHash(it.text);

      const { fresh } = await freshItems(collection, items, { skipStored: false });
      const vectors = await embedTexts(fresh.map((c) => c.text), req.body.embed);
      const rows = fresh.map((c, i) => ({ ...c, vector: vectors[i] }));
      await store.upsert(collection, rows);
      rememberHashes(collection, rows);
      res.json({ inserted: rows.length });
    }),
  );

  router.post(
    "/query",
    asyncHandler(async (req, res) => {
      // Accept either a single `searchText` (classic) or `searchTexts[]`
      // (Agent-Mode: multiple sub-queries fused together). Back-compat: a lone
      // searchText behaves exactly as before.
      let searchTexts = Array.isArray(req.body.searchTexts)
        ? req.body.searchTexts.map((s) => String(s ?? "").trim()).filter(Boolean)
        : [];
      if (!searchTexts.length) {
        const single = String(req.body.searchText ?? "").trim();
        if (single) searchTexts = [single];
      }
      if (!searchTexts.length) throw new HttpError(400, "searchText or searchTexts[] required");
      if (searchTexts.length > MAX_SUBQUERIES) searchTexts = searchTexts.slice(0, MAX_SUBQUERIES);

      // Optional entity hints -> soft-boost in the re-ranker (not a hard filter).
      const entities = Array.isArray(req.body.entities)
        ? req.body.entities.map((e) => String(e ?? "").trim()).filter(Boolean).slice(0, MAX_ENTITIES)
        : [];

      const topK = clampInt(req.body.topK, 5, 1, MAX_TOPK);
      const threshold = clampFloat(req.body.threshold, 0, 0, 1);
      const hybrid = req.body.hybrid !== false; // default on
      const weights = req.body.weights && typeof req.body.weights === "object" ? req.body.weights : undefined;

      const collections = Array.isArray(req.body.collections)
        ? req.body.collections.map(safeCollection)
        : [safeCollection(req.body.collection)];

      // In hybrid mode over-fetch a wider candidate pool (so BM25 can surface
      // keyword matches the dense layer ranked low) and gather inclusively; the
      // re-ranker + topK do the final cut. Dense-only mode keeps the hard floor.
      // clampInt(value, fallback, min, max): over-fetch topK*8 candidates, floor topK, cap 100.
      // (Bug fix: the max arg was previously omitted, so this evaluated to NaN -> vectorSearch
      // limit(NaN) -> "k must be positive" -> every hybrid query silently returned zero hits.)
      const candidateK = hybrid ? clampInt(topK * 8, topK, topK, 100) : topK;
      const gatherThreshold = hybrid ? 0 : threshold;

      // Embed all sub-queries in one batch, then gather a candidate list per
      // sub-query so each keeps its own dense/BM25 ranking for multi-list RRF.
      const vectors = await embedTexts(searchTexts, req.body.embed);
      const candidateLists = [];
      for (let qi = 0; qi < searchTexts.length; qi++) {
        const vector = vectors[qi];
        const list = [];
        for (const collection of collections) {
          const found = await store.query(collection, vector, candidateK, gatherThreshold);
          for (const h of found) list.push({ collection, ...h });
        }
        candidateLists.push(list);
      }

      let hits;
      if (hybrid) {
        hits = rerankMulti(searchTexts, candidateLists, { weights, entities }).slice(0, topK);
      } else {
        // Dense-only: merge the per-sub-query lists, dedup keeping the best
        // score, then sort. Preserves the hard threshold gathered above.
        const byKey = new Map();
        for (const list of candidateLists) {
          for (const h of list) {
            const key = `${h.collection}:${h.id ?? h.hash ?? h.text}`;
            const cur = byKey.get(key);
            if (!cur || h.score > cur.score) byKey.set(key, h);
          }
        }
        hits = [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, topK);
      }
      res.json({ hits, mode: hybrid ? "hybrid" : "dense", subqueries: searchTexts.length });
    }),
  );

  router.post(
    "/list",
    asyncHandler(async (req, res) => {
      const collection = safeCollection(req.body.collection);
      res.json({ hashes: await store.listHashes(collection) });
    }),
  );

  router.post(
    "/delete",
    asyncHandler(async (req, res) => {
      const collection = safeCollection(req.body.collection);
      const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : [];
      const hashes = Array.isArray(req.body.hashes) ? req.body.hashes.map(Number) : [];
      if (!ids.length && !hashes.length) throw new HttpError(400, "ids[] or hashes[] required");
      await store.remove(collection, { ids, hashes });
      // Rebuilt rather than picked apart: `ids` are stringified hashes today, but that is the store's
      // business, and a cache that quietly disagrees with the table would make an ingest skip a chunk
      // that is no longer there. A rebuild costs one scan on the next ingest.
      forgetHashes(collection);
      res.json({ ok: true });
    }),
  );

  router.post(
    "/purge",
    asyncHandler(async (req, res) => {
      const collection = safeCollection(req.body.collection);
      await store.purge(collection);
      forgetHashes(collection);
      res.json({ ok: true, purged: collection });
    }),
  );

  router.post(
    "/purge-all",
    asyncHandler(async (_req, res) => {
      await store.purgeAll();
      forgetHashes();
      res.json({ ok: true });
    }),
  );

  return router;
}
