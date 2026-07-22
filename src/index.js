#!/usr/bin/env node
import { config } from "./config.js";
import { createStore } from "./stores/index.js";
import { createApp } from "./server.js";
import { log } from "./logger.js";

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
  app.listen(config.port, config.host, () => {
    log.info(`noodlr-memory listening on http://${config.host}:${config.port}  (backend=${store.name}, embed=${config.embed.provider}/${config.embed.model})`);
  });
}

main();
