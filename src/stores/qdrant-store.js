import { COLLECTION_IDS } from "../collections.js";

// Qdrant backend (VectFox precedent): best hybrid/scale behavior. Collections are
// created lazily once the embedding dimension is known (from the first upsert).
export class QdrantStore {
  constructor(cfg) {
    this.cfg = cfg;
    this._client = null;
    this._ensured = new Set();
  }

  get name() {
    return "qdrant";
  }

  async init() {
    const { QdrantClient } = await import("@qdrant/js-client-rest");
    const opts = { url: this.cfg.qdrantUrl };
    if (this.cfg.qdrantApiKey) opts.apiKey = this.cfg.qdrantApiKey;
    this._client = new QdrantClient(opts);
    await this._client.getCollections();
  }

  _name(collection) {
    return `noodlr_${collection}`;
  }

  async _ensure(collection, dim) {
    const name = this._name(collection);
    if (this._ensured.has(name)) return;
    const existing = await this._client.getCollections();
    const found = existing.collections?.some((c) => c.name === name);
    if (!found) {
      await this._client.createCollection(name, {
        vectors: { size: dim, distance: "Cosine" },
      });
    }
    this._ensured.add(name);
  }

  async upsert(collection, items) {
    if (!items.length) return;
    await this._ensure(collection, items[0].vector.length);
    await this._client.upsert(this._name(collection), {
      wait: true,
      points: items.map((it) => ({
        id: it.hash >>> 0,
        vector: it.vector,
        payload: { hash: it.hash, text: it.text, index: it.index, ...it.metadata },
      })),
    });
  }

  async query(collection, vector, topK, threshold) {
    const res = await this._client
      .search(this._name(collection), {
        vector,
        limit: topK,
        score_threshold: threshold,
        with_payload: true,
      })
      .catch(() => []);
    return res.map((p) => ({
      id: String(p.id),
      score: p.score,
      text: p.payload?.text,
      hash: Number(p.payload?.hash),
      metadata: p.payload ?? {},
    }));
  }

  async listHashes(collection) {
    const hashes = [];
    let offset = undefined;
    do {
      const res = await this._client
        .scroll(this._name(collection), { with_payload: true, limit: 256, offset })
        .catch(() => ({ points: [], next_page_offset: null }));
      for (const p of res.points ?? []) hashes.push(Number(p.payload?.hash));
      offset = res.next_page_offset ?? null;
    } while (offset);
    return hashes.filter((n) => Number.isFinite(n));
  }

  async remove(collection, { ids, hashes } = {}) {
    const points = [...(ids ?? []).map((x) => Number(x) >>> 0), ...(hashes ?? []).map((x) => Number(x) >>> 0)];
    if (points.length) await this._client.delete(this._name(collection), { wait: true, points });
  }

  async purge(collection) {
    this._ensured.delete(this._name(collection));
    await this._client.deleteCollection(this._name(collection)).catch(() => {});
  }

  async purgeAll() {
    for (const id of COLLECTION_IDS) await this.purge(id);
  }

  async stats() {
    const out = {};
    for (const id of COLLECTION_IDS) {
      try {
        const info = await this._client.getCollection(this._name(id));
        out[id] = { count: info.points_count ?? 0 };
      } catch {
        /* not created yet */
      }
    }
    return out;
  }
}
