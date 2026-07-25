import { resolve } from "node:path";
import { COLLECTION_IDS } from "../collections.js";
import { normalizeCosineFromL2Distance } from "./base.js";
import { log } from "../logger.js";

// Embedded LanceDB backend (via the official @lancedb/lancedb Node SDK). No external
// service and no Python: LanceDB is an in-process columnar vector store that writes Lance
// files directly under <lancedbUri>. One table per collection ("noodlr_<collection>"),
// created lazily on first upsert once the embedding dimension is known.
//
// Arbitrary per-chunk metadata is stored as a single JSON string column (`meta_json`) so
// the Arrow schema stays fixed regardless of which optional fields (importance, entities,
// ts, ...) a given chunk carries. We reconstruct the metadata object on read.
export class LanceStore {
  constructor(cfg) {
    this.uri = cfg.lancedbUri || resolve(cfg.dataDir, "lancedb");
    this._lancedb = null;
    this._db = null;
    this._tables = new Map(); // name -> Table handle
    this._writeChains = new Map(); // name -> Promise (serializes create/add per table)
  }

  get name() {
    return "lancedb";
  }

  async init() {
    this._lancedb = await import("@lancedb/lancedb");
    // connect() creates the directory if missing.
    this._db = await this._lancedb.connect(this.uri);
  }

  _name(collection) {
    return `noodlr_${collection}`;
  }

  /** Serialize writes per table so concurrent upserts can't race table creation. */
  _serialize(name, task) {
    const prev = this._writeChains.get(name) ?? Promise.resolve();
    const run = prev.then(task, task);
    // Keep a tail that never rejects so the chain survives a failed task.
    this._writeChains.set(
      name,
      run.then(
        () => {},
        () => {},
      ),
    );
    return run;
  }

  /** Open an existing table (cached), or null if it doesn't exist yet. */
  async _open(name) {
    if (this._tables.has(name)) return this._tables.get(name);
    const names = await this._db.tableNames();
    if (!names.includes(name)) return null;
    const t = await this._db.openTable(name);
    this._tables.set(name, t);
    return t;
  }

  _toRows(items) {
    return items.map((it) => ({
      id: String(it.hash),
      hash: Number(it.hash),
      text: String(it.text ?? ""),
      idx: Number(it.index ?? 0),
      meta_json: JSON.stringify(it.metadata ?? {}),
      vector: it.vector,
    }));
  }

  async upsert(collection, items) {
    if (!items.length) return;
    const name = this._name(collection);
    const rows = this._toRows(items);
    await this._serialize(name, async () => {
      // Upsert semantics: drop any existing rows with the same ids, then add.
      let table = await this._open(name);
      if (table) {
        const ids = rows.map((r) => `'${r.id}'`).join(", ");
        await table.delete(`id IN (${ids})`).catch(() => {});
        await table.add(rows);
      } else {
        table = await this._db.createTable(name, rows);
        this._tables.set(name, table);
      }
    });
  }

  async query(collection, vector, topK, threshold) {
    const name = this._name(collection);
    const table = await this._open(name);
    if (!table) return [];
    // Surface (don't swallow) the real vectorSearch failure. A common cause is a query/table
    // embedding-dimension mismatch (e.g. the silo was first written with a different embed model),
    // which returns zero hits — logging the dim + message makes that diagnosable instead of silent.
    const results = await table
      .vectorSearch(vector)
      .distanceType("cosine")
      .limit(topK)
      .toArray()
      .catch((err) => {
        const dim = Array.isArray(vector) ? vector.length : "?";
        log.warn(`lancedb vectorSearch failed on "${name}" (query dim=${dim}): ${err?.message ?? err}`);
        return [];
      });
    return results
      .map((r) => {
        const score = normalizeCosineFromL2Distance(r._distance);
        let meta = {};
        try {
          meta = JSON.parse(r.meta_json ?? "{}");
        } catch {
          meta = {};
        }
        return {
          id: String(r.id),
          score,
          text: r.text,
          hash: Number(r.hash),
          metadata: { hash: Number(r.hash), text: r.text, index: Number(r.idx), ...meta },
        };
      })
      .filter((h) => h.score >= threshold);
  }

  async listHashes(collection) {
    const table = await this._open(this._name(collection));
    if (!table) return [];
    // No implicit small cap on a plain (non-vector) scan; select only the hash column.
    const rows = await table
      .query()
      .select(["hash"])
      .toArray()
      .catch((err) => {
        log.warn(`lancedb listHashes failed on "${this._name(collection)}": ${err?.message ?? err}`);
        return [];
      });
    return rows.map((r) => Number(r.hash)).filter((n) => Number.isFinite(n));
  }

  async remove(collection, { ids, hashes } = {}) {
    const table = await this._open(this._name(collection));
    if (!table) return;
    const targets = new Set();
    for (const x of ids ?? []) targets.add(String(x));
    for (const h of hashes ?? []) targets.add(String(h));
    if (targets.size === 0) return;
    const list = [...targets].map((x) => `'${x.replace(/'/g, "''")}'`).join(", ");
    await this._serialize(this._name(collection), () =>
      table.delete(`id IN (${list})`).catch(() => {}),
    );
  }

  async purge(collection) {
    const name = this._name(collection);
    this._tables.delete(name);
    await this._db.dropTable(name).catch(() => {});
  }

  async purgeAll() {
    for (const id of COLLECTION_IDS) await this.purge(id);
  }

  async stats() {
    const out = {};
    const names = await this._db.tableNames().catch(() => []);
    for (const id of COLLECTION_IDS) {
      const name = this._name(id);
      if (!names.includes(name)) continue;
      try {
        const table = await this._open(name);
        out[id] = { count: await table.countRows() };
      } catch {
        out[id] = { count: 0 };
      }
    }
    return out;
  }
}
