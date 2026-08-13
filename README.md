# noodlr-memory

Companion vector/RAG memory service for the **Noodlr** Foundry VTT module.

It provides embeddings + a real vector database, split into per-purpose
collections, so Noodlr can recall your campaign from a proper
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
- **Never pays to embed the same chunk twice.** `/ingest` and `/ingest-file` drop
  chunks the collection already holds and repeats within one request _before_
  embedding, and report them as `skipped` / `alreadyStored` / `repeats`. So
  re-ingesting a compendium after adding one book costs only the new material,
  and an interrupted run can simply be started again.

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

Point the Noodlr module's **Memory Configuration** window at `http://127.0.0.1:3010` and use the
same secret. That address only works when Foundry, this service, and the browser are all on the
one machine — for anything else, put the service behind the web server that already serves Foundry
and give the module the proxied path instead (see [DEPLOYMENT.md](DEPLOYMENT.md) §6).

Zero-setup first run (no external DB):

```bash
VECTOR_BACKEND=vectra EMBED_PROVIDER=openrouter EMBED_API_KEY=sk-or-... npm start
```

## HTTP API (all under `/v1`, all POST unless noted)

- `GET /v1/health` -> `{ ok, backend }`
- `GET /v1/collections` -> `{ collections, stats }`
- `POST /v1/ingest` `{ collection, documents:[{text, kind?, metadata?}], embed?, chunk? }`
  - chunks -> skips what is already stored -> embeds -> upserts. `kind:"table"`
    documents are stored atomically.
  - -> `{ inserted, chunks, skipped, alreadyStored, repeats }`
- `POST /v1/insert` `{ collection, items:[{text, metadata?}], embed? }` (pre-chunked)
  - deliberately does **not** skip stored hashes: this is the path a memory is
    retracted or edited through, so a re-write of identical text with new metadata
    has to land.
- `POST /v1/query` `{ collection | collections[], searchText, topK?, threshold?, hybrid?, weights?, embed? }`
  - `hybrid` (default `true`) enables dense+BM25 fusion + importance/recency re-rank; `false` = pure dense.
  - `weights` (optional): `{ cosine, bm25, importance, recency }` to tune the re-ranker.
- `POST /v1/list` `{ collection }` -> `{ hashes }`
- `POST /v1/delete` `{ collection, ids?|hashes? }`
- `POST /v1/purge` `{ collection }` / `POST /v1/purge-all`

`embed` (optional per request) overrides `.env` defaults:
`{ provider:"openrouter"|"custom"|"mock", model, baseUrl, apiKey, batchSize, minIntervalMs }`.
The last two are not credentials, so the module sends them whether or not the GM
has opted into sharing a provider block.

### If a provider rate-limits you

A rate limit counts **requests**, not texts, so the levers in order of effect:

1. `EMBED_BATCH_SIZE` (default 64) — the same corpus in a quarter of the requests
   at 16 -> 64. `EMBED_MAX_CHARS_PER_REQUEST` splits an over-long batch so raising
   this cannot start producing payloads a provider rejects.
2. `EMBED_HEDGE_MS=0` for bulk work. Hedging is an interactive-latency trick and
   only ever fires for a **single** text now; a duplicate request is another
   request against the same limit.
3. `EMBED_MIN_INTERVAL_MS` — a deliberate floor. A refusal costs the wait _and_
   the request, so going slowly on purpose finishes sooner than being refused.
4. `EMBED_PROVIDER=transformers` embeds in-process, with no limit at all.

A 429 is logged with **which** limiter refused, because the two have opposite
remedies: OpenRouter's own cap on your key (fixable with credits, or by leaving a
`:free` model), or an upstream provider's capacity relayed through it. The second
is often not about your rate at all — the log reports how many providers serve the
model, and where that is **one**, OpenRouter cannot route around a busy provider,
so a single request can be refused seconds after an identical one succeeded. Change
model or embed locally; pacing will not help. Measured twice on a single-provider
model, the refusal landed within the first two requests of a **cold** process and
cleared 250ms later in one run, 500ms in the other — a limit your own rate could
trip cannot do that. Hence `EMBED_PACE_MAX_MS` defaults to 0 (no self-pacing after
a 429), the first wait is 500ms rather than 20s and doubles from there, and a
refusal the service retries away is logged at `info` rather than as a warning.

**`node scripts/probe-rate.mjs`** measures what your provider actually tolerates,
talking to it directly with every retry, hedge and pace bypassed: `sweep`, `recover`,
`batch`, `routing`. Run `recover` a few times before changing any wait — it moved by
2x between runs on one host, so a single sample is not a number to tune to.

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
