# Noodlr Memory — Linux deployment guide

`noodlr-memory` is a small standalone Node service that gives the Noodlr Foundry
VTT module a real vector/RAG memory: it computes embeddings and stores them in a
vector database, split into per-purpose collections (silos) that can be reset
independently.

```
Foundry (browser)  ──HTTP──▶  noodlr-memory  ──▶  vector DB (Chroma / Qdrant / Vectra)
   Noodlr module                  │
                                  └──▶  embeddings: OpenRouter | local server | in-process
```

This guide covers a production-style install on Linux (systemd), the vector-DB
options, and how to run embeddings locally (no cloud) if you prefer.

---

## 1. Prerequisites

- Linux with **Node.js >= 20** (`node -v`). Install via your distro or nodesource.
- A vector backend (pick one in section 3). The zero-dependency default is Vectra
  (local JSON files) — good for getting started.
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
sudo -u noodlr npm install --omit=dev            # core deps
# optional backends / features, install only what you use:
sudo -u noodlr npm install chromadb              # if VECTOR_BACKEND=chroma
sudo -u noodlr npm install @qdrant/js-client-rest # if VECTOR_BACKEND=qdrant
sudo -u noodlr npm install @huggingface/transformers # if EMBED_PROVIDER=transformers
sudo -u noodlr npm install pdf-parse             # if you import PDFs
```

---

## 2. Configuration

Copy the example env and edit it:

```bash
sudo -u noodlr cp /opt/noodlr-memory/.env.example /opt/noodlr-memory/.env
sudo -u noodlr chmod 600 /opt/noodlr-memory/.env   # it may hold an API key
sudo -u noodlr $EDITOR /opt/noodlr-memory/.env
```

Key settings:

- `FAMILIAR_MEMORY_HOST` — keep `127.0.0.1` unless exposing on a trusted LAN.
- `FAMILIAR_MEMORY_PORT` — default `3010`.
- `FAMILIAR_MEMORY_SECRET` — set a long random secret; the module must send the
  same value. Generate one: `openssl rand -hex 32`.
- `VECTOR_BACKEND` — `vectra` | `chroma` | `qdrant` (section 3).
- `EMBED_PROVIDER` / `EMBED_MODEL` / `EMBED_BASE_URL` / `EMBED_API_KEY` (section 4).

> The embedding config can also be supplied per-request from the module's RAG
> tab. Setting it in `.env` keeps API keys server-side so they never leave the host.

---

## 3. Vector backend

### Option A — Vectra (no external service)

Nothing to install beyond the service itself. Indexes are JSON files under
`FAMILIAR_MEMORY_DATA_DIR` (default `/opt/noodlr-memory/data`). Set
`VECTOR_BACKEND=vectra`. Best for small/medium campaigns and first runs.

### Option B — Chroma

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

### Option C — Qdrant

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
# {"ok":true,"backend":"vectra"}
```

---

## 6. Exposing to other machines (optional)

By default the service binds `127.0.0.1` and is reached only from the same host.
If Foundry runs elsewhere:

- Prefer an SSH tunnel or a reverse proxy (nginx/Caddy) terminating TLS, rather
  than binding `0.0.0.0` directly.
- Always set a strong `FAMILIAR_MEMORY_SECRET`.
- Restrict with a firewall (`ufw allow from <foundry-ip> to any port 3010`).

Example Caddy block (TLS + forward):

```
memory.example.com {
    reverse_proxy 127.0.0.1:3010
}
```

Then set the module's RAG service URL to `https://memory.example.com`.

---

## 7. Connect the Noodlr module

In Foundry: Noodlr settings → **Memory (RAG)** tab:

1. Enable vector memory; set **Service URL** and **Service secret** to match `.env`.
2. Choose the embedding provider/model matching the service.
3. Click **Test service** — it should report the backend and per-collection counts.
4. Force-ingest compendiums and import TXT/PDF docs into the collections you want.

---

## 8. Maintenance

- Update: replace the code, `sudo -u noodlr npm install --omit=dev`, `sudo systemctl restart noodlr-memory`.
- Reset one silo: use the per-collection **Reset** button in the RAG tab (or `POST /v1/purge`).
- Back up: the `data/` dir (Vectra), the Chroma/Qdrant volume as applicable.
- Logs: `journalctl -u noodlr-memory`.

## 9. Troubleshooting

- **Test fails / connection refused** — service not running or wrong URL/port; check `systemctl status` and `journalctl`.
- **401 unauthorized** — secret mismatch between `.env` and the module.
- **backend init error (chroma/qdrant)** — the DB isn't reachable at its URL; or use `VECTOR_BACKEND=vectra` for zero-setup.
- **first query slow (transformers)** — the model is downloading/loading on first use; subsequent calls are fast.
- **empty retrieval after changing embedding model** — reset the affected collections and re-ingest; vectors are model-specific.
