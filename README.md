# noodlr-memory

Companion vector/RAG memory service for the **Noodlr** Foundry VTT module.

It provides embeddings + a real vector database, split into per-purpose
collections, so the AI co-pilot can recall your campaign from a proper
retrieval index instead of browser-local storage. Inspired by SillyTavern's
Vector Storage (Data Bank) and VectFox.

## What it does

- Computes embeddings three ways, so you never have to use a cloud provider if
  you don't want to:
  - **OpenRouter** (cloud API; default model `perplexity/pplx-embed-v1-4b`),
  - a **local OpenAI-compatible server** (`custom`): Ollama, vLLM, llama.cpp, LM Studio,
  - **fully in-process** (`transformers`): Transformers.js runs the model inside this
    service with no external server or key (optional `@huggingface/transformers` dep).
  Keys can live server-side in `.env` or be supplied per-request by the module.
- Stores vectors in a **pluggable backend**: `chroma` (default), `qdrant`, or
  `vectra` (file-based, zero external service).
- Splits memory into independent **collections** by purpose, each resettable on
  its own: `chat`, `lore`, `rules`, `sheets`, `npc_state`, `factions`, `scenes`,
  `quests`, `docs`.
- Chunks ingested text with a **prose/table-aware** chunker so roll tables and
  stat blocks stay intact instead of being shredded across chunk boundaries.
- **Hybrid retrieval** (on by default): dense semantic search fused with a sparse
  BM25 keyword signal via Reciprocal Rank Fusion, then re-ranked by structured
  signals — `importance` and `recency` — so an exact keyword match the dense layer
  ranked low can still surface, and important/recent memories are favored.
- Accepts **structured events** (`kind: "event"`) that carry `importance`,
  `entities`, `keywords`, `event_type`, and `ts` metadata; events are stored
  atomically and their fields drive the re-ranker.

## Requirements

- Node.js >= 20.
- For the default `chroma` backend: a running [Chroma](https://www.trychroma.com/)
  server (`CHROMA_URL`, default `http://localhost:8000`).
- For `qdrant`: a running/hosted [Qdrant](https://qdrant.tech/) (`QDRANT_URL`).
- For `vectra`: nothing — it writes JSON indexes under `NOODLR_MEMORY_DATA_DIR`.
  This is the easiest first run.

## Setup

```bash
cd noodlr-memory
cp .env.example .env      # then edit: set NOODLR_MEMORY_SECRET, pick VECTOR_BACKEND, embedding key
npm install
npm start
```

For a production Linux install (systemd units, Chroma/Qdrant setup, and local
embedding via Ollama or in-process Transformers.js), see **[DEPLOYMENT.md](DEPLOYMENT.md)**.

Point the Noodlr module's RAG tab at `http://127.0.0.1:3010` and use the
same secret.

Zero-setup first run (no external DB):

```bash
VECTOR_BACKEND=vectra EMBED_PROVIDER=openrouter EMBED_API_KEY=sk-or-... npm start
```

## HTTP API (all under `/v1`, all POST unless noted)

- `GET /v1/health` -> `{ ok, backend }`
- `GET /v1/collections` -> `{ collections, stats }`
- `POST /v1/ingest` `{ collection, documents:[{text, kind?, metadata?}], embed?, chunk? }`
  - chunks -> embeds -> upserts. `kind:"table"` documents are stored atomically.
- `POST /v1/insert` `{ collection, items:[{text, metadata?}], embed? }` (pre-chunked)
- `POST /v1/query` `{ collection | collections[], searchText, topK?, threshold?, hybrid?, weights?, embed? }`
  - `hybrid` (default `true`) enables dense+BM25 fusion + importance/recency re-rank; `false` = pure dense.
  - `weights` (optional): `{ cosine, bm25, importance, recency }` to tune the re-ranker.
- `POST /v1/list` `{ collection }` -> `{ hashes }`
- `POST /v1/delete` `{ collection, ids?|hashes? }`
- `POST /v1/purge` `{ collection }` / `POST /v1/purge-all`

`embed` (optional per request) overrides `.env` defaults:
`{ provider:"openrouter"|"custom"|"mock", model, baseUrl, apiKey }`.

All requests require the `x-noodlr-secret` header when `NOODLR_MEMORY_SECRET`
is set.

## Security notes

- Binds to `127.0.0.1` by default. Only expose on a trusted LAN, and always set a
  secret if you do.
- Collection names are strictly allow-listed and run through `sanitize-filename`
  before touching disk (no path traversal).
- Embedding API keys are never logged. Prefer storing them in `.env` so they stay
  server-side rather than being sent from the browser.
- Request bodies are size-capped (`NOODLR_MEMORY_MAX_BODY_MB`).

## Testing

```bash
npm test
```

Runs the chunker unit tests and a file-based insert/query round-trip using a
deterministic offline mock embedder (no network, no API key).

## License

MIT.
