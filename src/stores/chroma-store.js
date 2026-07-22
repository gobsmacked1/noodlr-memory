import { normalizeCosineFromL2Distance } from "./base.js";
import { COLLECTION_IDS } from "../collections.js";

// Default backend. Requires a running Chroma server (CHROMA_URL). Each purpose
// maps to a Chroma collection configured for cosine space. We always pass
// embeddings/queryEmbeddings directly, so no server-side embedding function runs.
const NOOP_EF = {
  generate: async () => {
    throw new Error("embeddings are computed by noodlr-memory, not Chroma");
  },
};

export class ChromaStore {
  constructor(cfg) {
    this.cfg = cfg;
    this._client = null;
    this._collections = new Map();
  }

  get name() {
    return "chroma";
  }

  async init() {
    const { ChromaClient } = await import("chromadb");
    const opts = { path: this.cfg.chromaUrl };
    if (this.cfg.chromaAuthToken) {
      opts.auth = { provider: "token", credentials: this.cfg.chromaAuthToken };
    }
    this._client = new ChromaClient(opts);
    await this._client.heartbeat();
  }

  async _col(collection) {
    if (this._collections.has(collection)) return this._collections.get(collection);
    const col = await this._client.getOrCreateCollection({
      name: `noodlr_${collection}`,
      metadata: { "hnsw:space": "cosine" },
      embeddingFunction: NOOP_EF,
    });
    this._collections.set(collection, col);
    return col;
  }

  async upsert(collection, items) {
    if (!items.length) return;
    const col = await this._col(collection);
    await col.upsert({
      ids: items.map((it) => String(it.hash)),
      embeddings: items.map((it) => it.vector),
      documents: items.map((it) => it.text),
      metadatas: items.map((it) => ({ hash: it.hash, index: it.index, ...it.metadata })),
    });
  }

  async query(collection, vector, topK, threshold) {
    const col = await this._col(collection);
    const res = await col.query({ queryEmbeddings: [vector], nResults: topK });
    const ids = res.ids?.[0] ?? [];
    const docs = res.documents?.[0] ?? [];
    const metas = res.metadatas?.[0] ?? [];
    const dists = res.distances?.[0] ?? [];
    const hits = [];
    for (let i = 0; i < ids.length; i++) {
      const score = normalizeCosineFromL2Distance(dists[i]);
      if (score < threshold) continue;
      hits.push({
        id: ids[i],
        score,
        text: docs[i],
        hash: Number(metas[i]?.hash),
        metadata: metas[i] ?? {},
      });
    }
    return hits;
  }

  async listHashes(collection) {
    const col = await this._col(collection);
    const res = await col.get();
    return (res.metadatas ?? []).map((m) => Number(m?.hash)).filter((n) => Number.isFinite(n));
  }

  async remove(collection, { ids, hashes } = {}) {
    const col = await this._col(collection);
    const idList = [...(ids ?? []).map(String), ...(hashes ?? []).map(String)];
    if (idList.length) await col.delete({ ids: idList });
  }

  async purge(collection) {
    this._collections.delete(collection);
    await this._client.deleteCollection({ name: `noodlr_${collection}` }).catch(() => {});
  }

  async purgeAll() {
    for (const id of COLLECTION_IDS) await this.purge(id);
  }

  async stats() {
    const out = {};
    for (const id of COLLECTION_IDS) {
      try {
        const col = await this._col(id);
        out[id] = { count: await col.count() };
      } catch {
        /* collection not created yet */
      }
    }
    return out;
  }
}
