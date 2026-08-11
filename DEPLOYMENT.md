# Noodlr Memory — Linux deployment guide

`noodlr-memory` is a small standalone Node service that gives the Noodlr Foundry
VTT module a real vector/RAG memory: it computes embeddings and stores them in a
vector database, split into per-purpose collections (silos) that can be reset
independently.

```
Foundry (browser)  ──HTTP──▶  noodlr-memory  ──▶  vector DB (LanceDB / Qdrant / Chroma / Vectra)
   Noodlr module                  │
                                  └──▶  embeddings: OpenRouter | local server | in-process
```

This guide covers a production-style install on Linux (systemd), the vector-DB
options, and how to run embeddings locally (no cloud) if you prefer.

---

## 1. Prerequisites

- Linux with **Node.js >= 20** (`node -v`). Install via your distro or nodesource.
- A vector backend (pick one in section 3). The default is **LanceDB** — embedded and
  in-process (no separate service, no Python), installed automatically with the core deps.
- An embedding source (section 4): OpenRouter API key, a local embedding server,
  or the fully in-process option.

Create a dedicated unprivileged user and lay the code down under `/opt`:

```bash
sudo useradd --system --home /opt/noodlr-memory --shell /usr/sbin/nologin noodlr
sudo mkdir -p /opt/noodlr-memory
# copy the noodlr-memory/ directory here (git clone, scp, rsync, or release tarball)
sudo rsync -a ./noodlr-memory/ /opt/noodlr-memory/
sudo chown -R noodlr:noodlr /opt/noodlr-memory
```

Install dependencies (as the service user):

```bash
cd /opt/noodlr-memory
sudo -u noodlr npm install --omit=dev            # core deps (includes embedded LanceDB)
# optional backends / features, install only what you use:
sudo -u noodlr npm install @qdrant/js-client-rest # if VECTOR_BACKEND=qdrant
sudo -u noodlr npm install chromadb              # if VECTOR_BACKEND=chroma
sudo -u noodlr npm install @huggingface/transformers # if EMBED_PROVIDER=transformers
sudo -u noodlr npm install pdf-parse             # if you import PDFs
```

> **Do not use `--omit=optional`.** LanceDB's compiled binary ships as a platform-specific
> *optional* dependency (the same pattern as esbuild/sharp), so omitting optionals removes the
> native module and LanceDB won't load. `--omit=dev` is correct. Any `onnxruntime-node`/`sharp`
> install-script warnings are harmless unless you use the in-process `transformers` embedder.

---

## 2. Configuration

Copy the example env and edit it:

```bash
sudo -u noodlr cp /opt/noodlr-memory/.env.example /opt/noodlr-memory/.env
sudo -u noodlr chmod 600 /opt/noodlr-memory/.env   # it may hold an API key
sudo -u noodlr $EDITOR /opt/noodlr-memory/.env
```

Key settings:

- `NOODLR_MEMORY_HOST` — keep `127.0.0.1` unless exposing on a trusted LAN.
- `NOODLR_MEMORY_PORT` — default `3010`. Set to `0` to run with no TCP port at all
  (only sensible together with `NOODLR_MEMORY_SOCKET`).
- `NOODLR_MEMORY_SOCKET` — optional Unix socket, listened on **in addition** to the TCP
  port, for a reverse proxy on this machine. Ignored on Windows.
- `NOODLR_MEMORY_SECRET` — set a long random secret; the module must send the
  same value. Generate one: `openssl rand -hex 32`.
- `VECTOR_BACKEND` — `lancedb` | `vectra` | `qdrant` | `chroma` (section 3).
- `LANCEDB_URI` — optional. Leave unset to keep LanceDB self-contained under
  `<DATA_DIR>/lancedb` (recommended). Only set it to use an external directory.
- `EMBED_PROVIDER` / `EMBED_MODEL` / `EMBED_BASE_URL` / `EMBED_API_KEY` (section 4).

> The embedding config can also be supplied per-request from the module's RAG
> tab. Setting it in `.env` keeps API keys server-side so they never leave the host.

---

## 3. Vector backend

### Option A — LanceDB (embedded, recommended)

Nothing extra to run: LanceDB is an in-process columnar vector store (no server, no
Python). The `@lancedb/lancedb` native module installs with the core deps. Just set
`VECTOR_BACKEND=lancedb` and leave `LANCEDB_URI` unset — data lands self-contained under
`<DATA_DIR>/lancedb` (default `/opt/noodlr-memory/data/lancedb`), created automatically.
Back up that folder like any data directory; that's the whole database.

To use an external directory instead, set `LANCEDB_URI=/path/to/dir` and ensure the service
user owns it:

```bash
sudo mkdir -p /opt/lancedb_data && sudo chown noodlr:noodlr /opt/lancedb_data
# in .env:  VECTOR_BACKEND=lancedb   LANCEDB_URI=/opt/lancedb_data
```

> Only one process may write a LanceDB directory at a time. If you experimented with a
> separate Python LanceDB/FastAPI server against a folder, stop and remove it — noodlr-memory
> is the sole writer now.

### Option B — Vectra (no external service)

Nothing to install beyond the service itself. Indexes are JSON files under
`NOODLR_MEMORY_DATA_DIR` (default `/opt/noodlr-memory/data`). Set
`VECTOR_BACKEND=vectra`. A tiny fallback for minimal setups.

### Option C — Chroma

Run Chroma with Docker (simplest) and point the service at it
(`VECTOR_BACKEND=chroma`, `CHROMA_URL=http://localhost:8000`):

```bash
sudo docker run -d --name chroma --restart unless-stopped \
  -p 127.0.0.1:8000:8000 \
  -v /opt/chroma-data:/data \
  chromadb/chroma:latest
```

Or run it from pip under its own systemd unit (`/etc/systemd/system/chroma.service`):

```ini
[Unit]
Description=Chroma vector database
After=network-online.target

[Service]
Type=simple
User=noodlr
ExecStart=/usr/bin/env chroma run --host 127.0.0.1 --port 8000 --path /opt/chroma-data
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/chroma-data

[Install]
WantedBy=multi-user.target
```

```bash
pipx install chromadb        # or: pip install chromadb
sudo mkdir -p /opt/chroma-data && sudo chown noodlr:noodlr /opt/chroma-data
sudo systemctl enable --now chroma
```

### Option D — Qdrant

```bash
sudo docker run -d --name qdrant --restart unless-stopped \
  -p 127.0.0.1:6333:6333 \
  -v /opt/qdrant-data:/qdrant/storage \
  qdrant/qdrant:latest
```

Set `VECTOR_BACKEND=qdrant`, `QDRANT_URL=http://localhost:6333` (and
`QDRANT_API_KEY` if you enabled auth).

---

## 4. Embeddings — cloud or local

Pick ONE. Whatever generated the vectors must also be used to query them, so
don't switch models without resetting the affected collections.

### Cloud: OpenRouter

```
EMBED_PROVIDER=openrouter
EMBED_MODEL=perplexity/pplx-embed-v1-4b
EMBED_API_KEY=sk-or-...
```

### Local, in-process (no extra server)

Runs the embedding model inside `noodlr-memory` via Transformers.js. The ONNX
model downloads from HuggingFace once and is cached on disk.

```bash
sudo -u noodlr npm install @huggingface/transformers
```

```
EMBED_PROVIDER=transformers
EMBED_MODEL=Xenova/all-MiniLM-L6-v2      # any HF feature-extraction model id
```

The model cache lives under the service's home; ensure the `noodlr` user can
write it (the systemd unit below allows the working dir). CPU-only is fine for
the small models; expect a slower first request while the model loads.

### Local server (Ollama / vLLM / llama.cpp / LM Studio)

Any OpenAI-compatible `/v1/embeddings` endpoint. Example with Ollama:

```bash
# install Ollama (https://ollama.com), then:
ollama pull nomic-embed-text        # or mxbai-embed-large
```

```
EMBED_PROVIDER=custom
EMBED_BASE_URL=http://localhost:11434/v1
EMBED_MODEL=nomic-embed-text
EMBED_API_KEY=                        # blank is fine for local servers
```

- **vLLM**: `EMBED_BASE_URL=http://localhost:8000/v1`, model = the served model id.
- **llama.cpp**: run `server` with `--embedding`; `EMBED_BASE_URL=http://localhost:8080/v1`.
- **LM Studio**: enable the local server; `EMBED_BASE_URL=http://localhost:1234/v1`.

---

## 5. Run as a systemd service

`/etc/systemd/system/noodlr-memory.service`:

```ini
[Unit]
Description=Noodlr Memory (vector/RAG service for Foundry VTT)
After=network-online.target
Wants=network-online.target
# If using a local backend as a unit, order after it:
# After=chroma.service

[Service]
Type=simple
User=noodlr
Group=noodlr
WorkingDirectory=/opt/noodlr-memory
EnvironmentFile=/opt/noodlr-memory/.env
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=3

# Unix-socket mode (see §6): create /run/noodlr-memory owned by this service, traversable
# by the proxy user's group. Uncomment when NOODLR_MEMORY_SOCKET is set.
# RuntimeDirectory=noodlr-memory
# RuntimeDirectoryMode=0750

# Hardening (least privilege)
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/noodlr-memory/data
# Transformers.js model cache (only if EMBED_PROVIDER=transformers):
# ReadWritePaths=/opt/noodlr-memory/data /opt/noodlr-memory/.cache

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now noodlr-memory
sudo systemctl status noodlr-memory
journalctl -u noodlr-memory -f        # follow logs
```

Health check:

```bash
curl -s http://127.0.0.1:3010/v1/health -H "x-noodlr-secret: $YOUR_SECRET"
# {"ok":true,"backend":"lancedb"}
```

---

## 6. Exposing to other machines (optional)

The Foundry module's RAG client runs in the **browser** (the GM's/players' machines),
never on the Foundry host — so the service must be reachable from those clients. The default
`127.0.0.1` bind is not. Three ways to expose it, best first:

### Option A — Reverse proxy behind nginx via a Unix socket (recommended)

The service listens on a Unix socket and nginx (already terminating TLS for Foundry) proxies a
path such as `/memory/` to it. This adds TLS, a single public origin reachable from anywhere, and
a protection layer in front of the service.

The socket is listened on **alongside** the TCP port, not instead of it — the default port stays
on `127.0.0.1`, where only this machine can reach it, which is convenient for `curl` and seed
scripts. Add `NOODLR_MEMORY_PORT=0` if you want the socket to be the only way in.

1. Configure the socket in `.env`:

   ```
   NOODLR_MEMORY_SOCKET=/run/noodlr-memory/noodlr-memory.sock
   NOODLR_MEMORY_SOCKET_MODE=660
   NOODLR_MEMORY_SECRET=<strong secret>
   ```

2. Let systemd own the socket dir and let nginx's user reach it (uncomment
   `RuntimeDirectory`/`RuntimeDirectoryMode` in the unit, §5), then:

   ```bash
   sudo usermod -aG noodlr www-data     # nginx user joins the service group (mode 660)
   sudo systemctl daemon-reload && sudo systemctl restart noodlr-memory
   sudo systemctl reload nginx
   ```

3. Add a location to the existing Foundry HTTPS `server { }` block. The `:/` after the socket
   strips the `/memory/` prefix so the service still sees `/v1/...`:

   ```nginx
   location /memory/ {
       proxy_pass http://unix:/run/noodlr-memory/noodlr-memory.sock:/;
       include /etc/nginx/snippets/proxy-common.conf;
       client_max_body_size 32m;    # match NOODLR_MEMORY_MAX_BODY_MB (large PDF/TXT ingests)
       proxy_read_timeout 300s;     # embedding/ingest can take a while
   }
   ```

4. In the module's **Memory Configuration** window set **How to reach the memory service** to
   *Behind the Foundry server* and the path to `/memory`. The module resolves it against Foundry's
   own origin, so the request is same-origin and inherits your TLS. (The older *Direct URL* option
   still works: `https://endless.secretdoor.app/memory`, no trailing slash.) Verify from anywhere:

   ```bash
   curl -s https://endless.secretdoor.app/memory/v1/health -H "x-noodlr-secret: $SECRET"
   # {"ok":true,"backend":"lancedb"}
   ```

> Public exposure means the **shared secret is the only guard** on write/purge endpoints. The
> module is GM-gated for this: only the GM's client ever contacts noodlr-memory, and the secret
> is stored **client-scope** on the GM's machine (never synced to player browsers). Keep it that
> way — don't hand the secret to players. For defense in depth on an internet-facing origin you
> can still restrict `/memory/` with nginx `allow`/`deny` or basic-auth.

### Option B — Reverse proxy over a local TCP port

Same as A but nginx targets the TCP listener instead of the socket:
`proxy_pass http://127.0.0.1:3010/;`. Simpler if you don't want a socket (and the only option on
Windows); still no public TCP.

### Option C — Direct LAN bind (trusted LAN only)

Set `NOODLR_MEMORY_HOST=0.0.0.0`, keep a strong secret, and firewall to the LAN:
`sudo ufw allow from 192.168.10.0/24 to any port 3010 proto tcp`. No TLS; use only on a
trusted network.

---

## 7. Connect the Noodlr module

In Foundry: Noodlr settings → **Memory & Knowledge** window:

1. Tick enable; set **Service URL** (e.g. `https://endless.secretdoor.app/memory`) and the
   write-only **shared secret** to match `.env`.
2. Choose the embedding provider/model matching the service (or leave server-side).
3. Click **Test connection** — it should report the backend (`lancedb`).
4. Open **Manage Memory** to force-ingest compendiums and import TXT/PDF docs into the
   silos you want.

---

## 8. Maintenance

- Update: replace the code, `sudo -u noodlr npm install --omit=dev`, `sudo systemctl restart noodlr-memory`.
- Reset one silo: use the per-collection **Reset** button in the RAG tab (or `POST /v1/purge`).
- Back up: the `LANCEDB_URI` dir (LanceDB), the `data/` dir (Vectra), or the Chroma/Qdrant volume as applicable.
- Logs: `journalctl -u noodlr-memory`.

## 9. Troubleshooting

- **Test fails / connection refused** — service not running or wrong URL/port; check `systemctl status` and `journalctl`.
- **401 unauthorized** — secret mismatch between `.env` and the module.
- **LanceDB write/lock error** — another process (e.g. a leftover Python LanceDB server) is writing the same `LANCEDB_URI`; stop it so noodlr-memory is the sole writer.
- **backend init error (chroma/qdrant)** — the DB isn't reachable at its URL; or use `VECTOR_BACKEND=lancedb` (embedded, zero-setup).
- **first query slow (transformers)** — the model is downloading/loading on first use; subsequent calls are fast.
- **empty retrieval after changing embedding model** — reset the affected collections and re-ingest; vectors are model-specific.
- **`embedding provider 429` during a bulk ingest** — the API key is over its provider's
  requests-per-minute limit. Since v1.1.1 a batch is retried with backoff (honouring `Retry-After`),
  the retry is shared across everything in flight, and hedging stands down for a minute so it stops
  doubling the request rate at the worst moment. If it still fails, in order of effect:
  1. **Raise `EMBED_BATCH_SIZE`** (16 → 64). A rate limit counts requests, not texts, so this is a
     straight 4× cut in calls for the same work. Try this first.
  2. **Set `EMBED_MIN_INTERVAL_MS`** to pace requests (1200 ≈ 50/min) if the limit is low enough
     that backoff is waiting more than working.
  3. **Ingest locally.** `EMBED_PROVIDER=transformers` embeds in-process with no network, no key and
     no limit — a good fit for a one-off bulk load of rulebooks. It changes the vector space, so
     **every collection must then use it**: switch only right after a full reset, never partway
     through a corpus, or old and new rows become unsearchable against each other.
- **self-test / query returns 0 hits even though ingest succeeded** — the write landed but the
  dense search returned nothing (`add` works, `vectorSearch` throws). Two known causes, both fixed
  by **purging the affected silo and re-ingesting**:
  1. **Legacy table** created by an older build/SDK whose `vector` column is a plain variable-length
     `List` instead of a searchable `FixedSizeList<Float32,N>`. Fresh tables created by the current
     build are correct, so purge lets the silo be recreated properly.
  2. **Embedding-dimension mismatch** — the silo was first written with a different embedding model.
  As of the current build the failure is logged with the table's actual vector type, e.g.
  `journalctl -u noodlr-memory -o cat -n 10` → `lancedb vectorSearch failed on "noodlr_docs"
  (query dim=1024) [table 'vector' type: List<Float32>]: ...`. `List<...>` ⇒ cause #1; a dim
  number that differs from the model's output ⇒ cause #2. Purge the silo (`node scripts/seed.mjs
  purge`, or `purge-all` to reset every silo) and re-ingest with one consistent embedding model.

### Diagnostic / seed tool (`scripts/seed.mjs`)

A standalone client that talks to the running service over HTTP exactly like the Foundry module
(same `/v1` routes, secret header, and per-request `embed` config). Use it to isolate whether a
problem is in the service or in the module. It never needs Foundry.

```bash
# Point it at the service; pass your real embed config so it mirrors the module.
export NOODLR_MEMORY_URL=https://your.host/memory      # or http://127.0.0.1:3010
export NOODLR_MEMORY_SECRET=<write-secret>
export EMBED_PROVIDER=openrouter EMBED_MODEL=<embed-slug> EMBED_API_KEY=<key>
export SILO=docs

node scripts/seed.mjs health         # ping
node scripts/seed.mjs collections    # per-silo row counts (proves writes persist)
node scripts/seed.mjs seed           # ingest 4 sample docs into $SILO
node scripts/seed.mjs query "who hid the silver dagger?"
node scripts/seed.mjs selftest       # ingest a unique marker, then read it back (with detail)
node scripts/seed.mjs purge          # wipe $SILO afterward to avoid contamination
```

Interpreting `selftest`: if it **succeeds here but fails in Foundry's Diagnostics**, the issue is
module-side. If it **fails here too**, it's the service/store — read the failure line (0 hits ⇒
check the service log for the `vectorSearch failed` reason, usually a dim mismatch ⇒ `purge`).

Silos are **created automatically** on first ingest (one LanceDB table per collection); there is
no manual initialization step. A silo simply won't appear in `collections` until something is
written to it.
