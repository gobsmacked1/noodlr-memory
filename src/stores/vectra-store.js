import { resolve } from "node:path";
import { rm, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";

// File-based fallback store (SillyTavern's default engine). No external service:
// one JSON index directory per collection under <dataDir>/vectra/<collection>.
export class VectraStore {
  constructor(cfg) {
    this.root = resolve(cfg.dataDir, "vectra");
    this._LocalIndex = null;
    this._indexes = new Map();
  }

  get name() {
    return "vectra";
  }

  async init() {
    const mod = await import("vectra");
    this._LocalIndex = mod.LocalIndex ?? mod.default?.LocalIndex ?? mod.default;
    await mkdir(this.root, { recursive: true });
  }

  async _index(collection) {
    if (this._indexes.has(collection)) return this._indexes.get(collection);
    const dir = resolve(this.root, collection);
    const index = new this._LocalIndex(dir);
    if (!(await index.isIndexCreated())) await index.createIndex();
    this._indexes.set(collection, index);
    return index;
  }

  // vectra changed queryItems arity across versions: (vector, topK) vs
  // (vector, query, topK). Pick by function arity so we work on both.
  async _query(index, vector, topK) {
    if (typeof index.queryItems === "function" && index.queryItems.length >= 3) {
      return index.queryItems(vector, "", topK);
    }
    return index.queryItems(vector, topK);
  }

  async upsert(collection, items) {
    const index = await this._index(collection);
    await index.beginUpdate();
    try {
      for (const it of items) {
        await index.upsertItem({
          id: String(it.hash),
          vector: it.vector,
          metadata: { hash: it.hash, text: it.text, index: it.index, ...it.metadata },
        });
      }
      await index.endUpdate();
    } catch (err) {
      if (typeof index.cancelUpdate === "function") index.cancelUpdate();
      throw err;
    }
  }

  async query(collection, vector, topK, threshold) {
    const index = await this._index(collection);
    const results = await this._query(index, vector, topK);
    return results
      .filter((r) => r.score >= threshold)
      .map((r) => ({
        id: r.item.id,
        score: r.score,
        text: r.item.metadata.text,
        hash: Number(r.item.metadata.hash),
        metadata: r.item.metadata,
      }));
  }

  async listHashes(collection) {
    const index = await this._index(collection);
    const items = await index.listItems();
    return items.map((x) => Number(x.metadata.hash));
  }

  async remove(collection, { ids, hashes } = {}) {
    const index = await this._index(collection);
    const targetIds = new Set((ids ?? []).map(String));
    if (hashes?.length) for (const h of hashes) targetIds.add(String(h));
    await index.beginUpdate();
    try {
      for (const id of targetIds) await index.deleteItem(id).catch(() => {});
      await index.endUpdate();
    } catch (err) {
      if (typeof index.cancelUpdate === "function") index.cancelUpdate();
      throw err;
    }
  }

  async purge(collection) {
    this._indexes.delete(collection);
    await rm(resolve(this.root, collection), { recursive: true, force: true });
  }

  async purgeAll() {
    this._indexes.clear();
    await rm(this.root, { recursive: true, force: true });
    await mkdir(this.root, { recursive: true });
  }

  async stats() {
    const out = {};
    if (!existsSync(this.root)) return out;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const index = await this._index(entry.name);
        out[entry.name] = { count: (await index.listItems()).length };
      } catch {
        out[entry.name] = { count: 0 };
      }
    }
    return out;
  }
}
