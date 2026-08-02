#!/usr/bin/env node
import { existsSync, unlinkSync, chmodSync } from "node:fs";
import { config } from "./config.js";
import { createStore } from "./stores/index.js";
import { createApp } from "./server.js";
import { log } from "./logger.js";

const embedInfo = () => `${config.embed.provider}/${config.embed.model}`;

/**
 * Listen on a Unix domain socket, for a reverse proxy on this machine.
 *
 * Runs alongside the TCP listener rather than replacing it: which one a given deployment needs is
 * the admin's call, not ours (Windows hosts have no socket at all; a Linux admin may well run the
 * service on a different box from Foundry). Resolves to true when the socket is listening.
 */
function listenOnSocket(app) {
  if (process.platform === "win32") {
    log.warn(
      `NOODLR_MEMORY_SOCKET is set but Unix domain sockets are not available on Windows - ignoring it and using TCP only.`,
    );
    return Promise.resolve(false);
  }

  // Remove a stale socket left by an unclean shutdown, else bind fails with EADDRINUSE.
  try {
    if (existsSync(config.socketPath)) unlinkSync(config.socketPath);
  } catch (err) {
    log.error(`Could not remove stale socket ${config.socketPath}: ${err.message}`);
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const server = app.listen(config.socketPath, () => {
      try {
        // parseInt base 8: "660" -> 0o660. Lets the proxy user's group connect.
        chmodSync(config.socketPath, parseInt(config.socketMode, 8));
      } catch (err) {
        log.warn(`Could not chmod socket to ${config.socketMode}: ${err.message}`);
      }
      resolve(true);
    });
    server.on("error", (err) => {
      log.error(`Could not listen on unix:${config.socketPath}: ${err.message}`);
      resolve(false);
    });
  });
}

/** Listen on host:port. Resolves to true when bound. */
function listenOnTcp(app) {
  return new Promise((resolve) => {
    const server = app.listen(config.port, config.host, () => resolve(true));
    server.on("error", (err) => {
      log.error(`Could not listen on http://${config.host}:${config.port}: ${err.message}`);
      if (err.code === "EADDRINUSE") {
        log.error(
          "Something else already holds that port. Change NOODLR_MEMORY_PORT, or set it to 0 to run on the Unix socket alone.",
        );
      }
      resolve(false);
    });
  });
}

/** Remove the socket file on shutdown so the next start doesn't trip over it. */
function installSocketCleanup() {
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

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/**
 * Say how exposed this process actually is, once the listeners are up and the answer is known.
 *
 * A bind address is easy to widen for an afternoon's testing and easy to forget afterwards, and the
 * write endpoints include purge. So the warning is scaled to the exposure rather than being the same
 * line every time: reachable-from-the-network is worth a warning even with a secret set, and
 * reachable-with-no-secret is an error however quietly it may be running.
 */
function warnAboutExposure(tcpBound) {
  const networkFacing = tcpBound && !isLoopbackHost(config.host);
  if (networkFacing && !config.secret) {
    log.error(
      `Listening on ${config.host}:${config.port} with NOODLR_MEMORY_SECRET empty - anyone who can reach this port can read, write, and PURGE your memory. Set a secret, or bind NOODLR_MEMORY_HOST to 127.0.0.1.`,
    );
    return;
  }
  if (networkFacing) {
    log.warn(
      `Listening on ${config.host}:${config.port} - reachable from other machines over plain HTTP, with the shared secret as the only guard. Intentional? If a reverse proxy fronts this service, bind NOODLR_MEMORY_HOST to 127.0.0.1 instead.`,
    );
  }
  if (!config.secret) {
    log.warn(
      "NOODLR_MEMORY_SECRET is not set - the API is unauthenticated. Set it in .env for anything beyond isolated local testing.",
    );
  }
}

async function main() {
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

  // Both listeners by default: the socket for a local reverse proxy, the port for anything that
  // has to come over the network (a Foundry host elsewhere, a Windows deployment, curl from your
  // desk). NOODLR_MEMORY_PORT=0 opts out of TCP for hosts that must expose no network port.
  const listeners = [];
  const tcpBound = config.port > 0 && (await listenOnTcp(app));
  if (tcpBound) {
    listeners.push(`http://${config.host}:${config.port}`);
  }
  if (config.socketPath && (await listenOnSocket(app))) {
    listeners.push(`unix:${config.socketPath} (mode ${config.socketMode})`);
    installSocketCleanup();
  }

  if (listeners.length === 0) {
    log.error("No listener could be started - nothing can reach the service. Exiting.");
    process.exit(1);
  }
  log.info(
    `noodlr-memory listening on ${listeners.join(" and ")}  (backend=${store.name}, embed=${embedInfo()})`,
  );
  warnAboutExposure(tcpBound);
}

main();
