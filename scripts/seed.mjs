#!/usr/bin/env node
// Standalone diagnostic + seeding tool for a RUNNING noodlr-memory service.
//
// It talks to the HTTP API exactly like the Foundry module does (same /v1 routes, same
// x-noodlr-secret header, same per-request `embed` config), so it reproduces — or rules out —
// module-side problems without Foundry in the loop. Use it to prove writes land and reads return.
//
// -----------------------------------------------------------------------------------------------
// CONFIG (environment variables; every embed var is optional — omit them to use the server's .env):
//   NOODLR_MEMORY_URL     base URL, no trailing /v1   (default http://127.0.0.1:3010)
//                         behind nginx use e.g.        https://your.host/memory
//   NOODLR_MEMORY_SECRET  the write (GM) secret sent as x-noodlr-secret
//   EMBED_PROVIDER        openrouter | custom | transformers | mock
//   EMBED_MODEL           embedding model slug (e.g. an OpenRouter embeddings model)
//   EMBED_BASE_URL        for provider=custom (OpenAI-compatible /embeddings base)
//   EMBED_API_KEY         embedding key (only if not stored server-side)
//   SILO                  target silo (default: docs)
//
// COMMANDS:
//   node scripts/seed.mjs health            # ping /v1/health
//   node scripts/seed.mjs collections       # list silos + live row counts (proves writes)
//   node scripts/seed.mjs seed              # ingest a few sample docs into SILO
//   node scripts/seed.mjs query "some text" # hybrid query against SILO, prints hits + scores
//   node scripts/seed.mjs selftest          # ingest a unique marker, then query it back (mirrors
//                                           # the module's Diagnostics self-test, with detail)
//   node scripts/seed.mjs purge             # DROP the SILO table (wipe test data)
//
// Typical isolation run (from the desktop, through nginx, with your real embed config):
//   NOODLR_MEMORY_URL=https://your.host/memory NOODLR_MEMORY_SECRET=... \
//   EMBED_PROVIDER=openrouter EMBED_MODEL=<embed-slug> EMBED_API_KEY=sk-... \
//   node scripts/seed.mjs selftest
// If selftest here SUCCEEDS but the Foundry Diagnostics fails -> module-side issue.
// If selftest here FAILS -> service/store issue (check the service log; vectorSearch errors are
// now logged, e.g. an embedding-dimension mismatch on a stale silo -> run `purge` and re-seed).
// -----------------------------------------------------------------------------------------------

const URL_BASE = (process.env.NOODLR_MEMORY_URL || "http://127.0.0.1:3010").replace(/\/+$/, "");
const SECRET = process.env.NOODLR_MEMORY_SECRET || "";
const SILO = process.env.SILO || "docs";

// Build the per-request embed override ONLY from provided vars. If none are set, the object is
// empty and the server falls back to its own .env embedding config (resolveEmbedConfig).
function embedConfig() {
  const e = {};
  if (process.env.EMBED_PROVIDER) e.provider = process.env.EMBED_PROVIDER;
  if (process.env.EMBED_MODEL) e.model = process.env.EMBED_MODEL;
  if (process.env.EMBED_BASE_URL) e.baseUrl = process.env.EMBED_BASE_URL;
  if (process.env.EMBED_API_KEY) e.apiKey = process.env.EMBED_API_KEY;
  return e;
}

async function api(path, body) {
  const headers = { "Content-Type": "application/json" };
  if (SECRET) headers["x-noodlr-secret"] = SECRET;
  const res = await fetch(`${URL_BASE}/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${path} -> HTTP ${res.status}: ${json.error ?? text.slice(0, 300)}`);
  }
  return json;
}

const SAMPLE_DOCS = [
  {
    text: "The rogue Vex hid a silver dagger under the loose floorboards of the Prancing Pony tavern in Neverwinter. He fears the return of the guild enforcer, One-Eyed Marla.",
    metadata: { entities: ["Vex", "Neverwinter", "Marla"], kind: "lore" },
  },
  {
    text: "The dragon Karastyx, an ancient red wyrm, hoards gold beneath the Sunless Citadel and guards a ruby crown said to grant dominion over fire elementals.",
    metadata: { entities: ["Karastyx", "Sunless Citadel"], kind: "lore" },
  },
  {
    text: "House rule: a natural 20 on a death saving throw restores the character to 1 HP and grants advantage on their next attack. Applies once per short rest.",
    metadata: { kind: "rules" },
  },
  {
    text: "Quest hook: the village of Greenrest has lost three children to the Whispering Wood over the last month. Tracks lead toward an abandoned fey crossing.",
    metadata: { entities: ["Greenrest", "Whispering Wood"], kind: "quest" },
  },
];

function printHits(res) {
  const hits = res.hits ?? [];
  console.log(`  mode=${res.mode ?? "?"} subqueries=${res.subqueries ?? 1} hits=${hits.length}`);
  hits.forEach((h, i) => {
    const score = typeof h.score === "number" ? h.score.toFixed(3) : h.finalScore?.toFixed?.(3) ?? "?";
    const snippet = String(h.text ?? "").replace(/\s+/g, " ").slice(0, 90);
    console.log(`   ${i + 1}. [${score}] (${h.collection ?? SILO}) ${snippet}`);
  });
  return hits;
}

async function cmdHealth() {
  console.log(await api("/health"));
}

async function cmdCollections() {
  const info = await api("/collections");
  const stats = info.stats ?? {};
  console.log("Silo document counts:");
  for (const id of Object.keys(info.collections ?? {})) {
    const s = stats[id];
    const count = typeof s === "number" ? s : s?.count ?? 0;
    console.log(`  ${id.padEnd(12)} ${count}`);
  }
}

async function cmdSeed() {
  const embed = embedConfig();
  console.log(`Seeding ${SAMPLE_DOCS.length} sample docs into "${SILO}" (embed: ${Object.keys(embed).length ? JSON.stringify({ ...embed, apiKey: embed.apiKey ? "***" : undefined }) : "server .env"})`);
  const before = await siloCount();
  const res = await api("/ingest", { collection: SILO, documents: SAMPLE_DOCS, embed });
  const after = await siloCount();
  console.log(`  inserted=${res.inserted} chunks=${res.chunks}; rows ${before} -> ${after}`);
  if (after <= before) console.log("  WARNING: row count did not increase — the write may not have persisted.");
}

async function cmdQuery(text) {
  if (!text) throw new Error('query needs text: node scripts/seed.mjs query "your question"');
  const embed = embedConfig();
  const res = await api("/query", { collections: [SILO], searchText: text, topK: 5, embed });
  printHits(res);
}

async function cmdSelfTest() {
  const embed = embedConfig();
  const marker = `noodlr-selftest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const markerText = `Noodlr diagnostics self-test ${marker}. This is a throwaway document safe to delete.`;
  console.log(`Self-test on "${SILO}" (embed: ${Object.keys(embed).length ? "override" : "server .env"})`);

  const before = await siloCount();
  const ing = await api("/ingest", { collection: SILO, documents: [{ text: markerText, metadata: { selftest: true } }], embed });
  const after = await siloCount();
  console.log(`  1) ingest: inserted=${ing.inserted} chunks=${ing.chunks}; rows ${before} -> ${after}`);
  if (after <= before) {
    console.log("  FAIL: write did not increase the row count. Ingest/embedding problem.");
    return;
  }

  const res = await api("/query", { collections: [SILO], searchText: markerText, topK: 5, embed });
  const hits = printHits(res);
  const found = hits.some((h) => String(h.text ?? "").includes(marker));
  if (found) {
    console.log("  2) query: OK — the marker round-tripped. Memory read/write is healthy.");
  } else if (hits.length === 0) {
    console.log("  FAIL: write succeeded but query returned 0 hits.");
    console.log("        => store/vectorSearch problem. Check the SERVICE LOG for a 'vectorSearch failed'");
    console.log(`        line (often an embedding-dimension mismatch on a stale silo). Fix: 'node scripts/seed.mjs purge' then re-run.`);
  } else {
    console.log("  FAIL: query returned hits but not the marker (ranking/embedding-consistency issue).");
  }
}

async function cmdPurge() {
  const res = await api("/purge", { collection: SILO });
  console.log(`Purged "${SILO}":`, res);
}

async function cmdPurgeAll() {
  const res = await api("/purge-all", {});
  console.log("Purged ALL silos:", res);
}

async function siloCount() {
  const info = await api("/collections").catch(() => ({ stats: {} }));
  const s = (info.stats ?? {})[SILO];
  return typeof s === "number" ? s : s?.count ?? 0;
}

const [cmd, ...rest] = process.argv.slice(2);
const commands = {
  health: cmdHealth,
  collections: cmdCollections,
  seed: cmdSeed,
  query: () => cmdQuery(rest.join(" ")),
  selftest: cmdSelfTest,
  purge: cmdPurge,
  "purge-all": cmdPurgeAll,
};

const run = commands[cmd];
if (!run) {
  console.log(`Unknown command "${cmd ?? ""}". Try: ${Object.keys(commands).join(", ")}`);
  console.log(`Target: ${URL_BASE}/v1  silo: ${SILO}  secret: ${SECRET ? "set" : "MISSING"}`);
  process.exit(1);
}
run().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
