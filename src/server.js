import express from "express";
import { createRouter } from "./routes/vectors.js";
import { HttpError } from "./sanitize.js";
import { log } from "./logger.js";

// Constant-time-ish secret check. The service is localhost-only by default;
// the shared secret defends against other local processes / CSRF-style abuse.
function authMiddleware(secret) {
  return (req, res, next) => {
    if (!secret) return next(); // dev mode (warned at startup)
    const provided = req.get("x-noodlr-secret") || "";
    if (provided.length === secret.length && timingSafeEqual(provided, secret)) return next();
    return res.status(401).json({ error: "unauthorized" });
  };
}

function timingSafeEqual(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i % b.length);
  return diff === 0;
}

export function createApp(config, store) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: `${config.maxBodyMb}mb` }));

  // Only local origins by default; the module talks to us from the Foundry page.
  app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", req.get("origin") || "*");
    res.set("Access-Control-Allow-Headers", "content-type,x-noodlr-secret");
    res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.use(authMiddleware(config.secret));
  app.use("/v1", createRouter(store));

  app.use((err, _req, res, _next) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) log.error(err);
    res.status(status).json({ error: err.message || "internal error" });
  });

  return app;
}
