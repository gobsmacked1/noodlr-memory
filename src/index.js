#!/usr/bin/env node
import { existsSync, unlinkSync, chmodSync } from "node:fs";
import { config } from "./config.js";
import { createStore } from "./stores/index.js";
import { createApp } from "./server.js";
import { log } from "./logger.js";

const embedInfo = () => `${config.embed.provider}/${config.embed.model}`;

/** Listen on a Unix domain socket (reverse-proxy mode). */
function listenOnSocket(app, store) {
  // Remove a stale socket left by an unclean shutdown, else bind fails with EADDRINUSE.
  try {
    if (existsSync(config.socketPath)) unlinkSync(config.socketPath);
  } catch (err) {
    log.error(`Could not remove stale socket ${config.socketPath}: ${err.message}`);
    process.exit(1);
  }

  app.listen(config.socketPath, () => {
    try {
      // parseInt base 8: "660" -> 0o660. Lets the proxy user's group connect.
      chmodSync(config.socketPath, parseInt(config.socketMode, 8));
    } catch (err) {
      log.warn(`Could not chmod socket to ${config.socketMode}: ${err.message}`);
    }
    log.info(
      `noodlr-memory listening on unix:${config.socketPath} (mode ${config.socketMode})  (backend=${store.name}, embed=${embedInfo()})`,
    );
  });

  // Remove the socket file on shutdown so the next start doesn't trip over it.
  const cleanup = () => {
    try {
      if (existsSync(config.socketPath)) unlinkSync(config.socketPath);
    } catch {
      /* best effort */
    }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

async function main() {
  if (!config.secret) {
    log.warn(
      "NOODLR_MEMORY_SECRET is not set - the API is unauthenticated. Set it in .env for anything beyond isolated local testing.",
    );
  }

  let store;
  try {
    store = await createStore(config);
  } catch (err) {
    log.error(`Failed to initialize vector backend "${config.backend}": ${err.message}`);
    if (config.backend === "chroma") log.error("Is the Chroma server running at " + config.chromaUrl + " ? (or set VECTOR_BACKEND=vectra for zero-setup file storage)");
    if (config.backend === "qdrant") log.error("Is Qdrant reachable at " + config.qdrantUrl + " ?");
    process.exit(1);
  }

  const app = createApp(config, store);
  if (config.socketPath) {
    listenOnSocket(app, store);
  } else {
    app.listen(config.port, config.host, () => {
      log.info(
        `noodlr-memory listening on http://${config.host}:${config.port}  (backend=${store.name}, embed=${embedInfo()})`,
      );
    });
  }
}

main();
