import { VectraStore } from "./vectra-store.js";
import { ChromaStore } from "./chroma-store.js";
import { QdrantStore } from "./qdrant-store.js";
import { LanceStore } from "./lance-store.js";

const BACKENDS = {
  lancedb: LanceStore,
  vectra: VectraStore,
  chroma: ChromaStore,
  qdrant: QdrantStore,
};

export async function createStore(config) {
  const Store = BACKENDS[config.backend];
  if (!Store) {
    throw new Error(
      `Unknown VECTOR_BACKEND "${config.backend}". Use one of: ${Object.keys(BACKENDS).join(", ")}`,
    );
  }
  const store = new Store(config);
  await store.init();
  return store;
}

export { LanceStore, VectraStore, ChromaStore, QdrantStore };
