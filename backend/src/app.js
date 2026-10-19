'use strict';

const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { validateItemInput } = require('./store');
const { createRateLimiter } = require('./ratelimit');

// Same policy nginx applies in the cluster; repeated here so local dev exercises it too.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const jsonLog = (entry) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
const PROBE_PATHS = new Set(['/healthz', '/readyz']);

function readBuildInfo(env = process.env) {
  return {
    service: 'backend',
    version: env.APP_VERSION || 'dev',
    commit: env.GIT_SHA || 'local',
    buildTime: env.BUILD_TIME || 'unknown',
    environment: env.APP_ENVIRONMENT || 'local',
    pod: env.HOSTNAME || os.hostname(),
  };
}

/**
 * Builds the express app. Dependencies are injected so tests can run it
 * without touching the network, environment or file system.
 *
 * @param {object} deps
 * @param {{get(): {spec: object, hash: string}}} deps.specProvider
 * @param {import('./store').ItemStore} deps.store
 * @param {object} [deps.buildInfo]
 * @param {string} [deps.frontendDir]  serve the static frontend (local dev only)
 * @param {{ready: boolean}} [deps.state]  flipped to false while draining
 * @param {number} [deps.trustProxy]  number of proxy hops in front of the app (for req.ip)
 * @param {{max?: number, writeMax?: number, windowMs?: number}} [deps.rateLimit]
 * @param {(entry: object) => void} [deps.log]  structured request logger
 */
function createApp({
  specProvider,
  store,
  buildInfo = readBuildInfo(),
  frontendDir,
  state = { ready: true },
  trustProxy = 0,
  rateLimit = {},
  log = jsonLog,
}) {
  const app = express();
  const startedAt = Date.now();
  let requestCount = 0;

  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);

  // ---- request logging + common headers -------------------------------------
  app.use((req, res, next) => {
    const began = process.hrtime.bigint();
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api/')) {
      requestCount += 1;
      res.set('Cache-Control', 'no-store');
    }
    res.on('finish', () => {
      if (PROBE_PATHS.has(req.path)) return;
      log({
        level: 'info',
        msg: 'request',
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - began) / 1000n) / 1000,
        ip: req.ip,
      });
    });
    next();
  });

  // ---- health (used by Kubernetes probes; never rate limited) ----------------
  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', (req, res) => {
    if (!state.ready) return res.status(503).json({ status: 'draining' });
    specProvider.get();
    res.json({ status: 'ready' });
  });

  // ---- API ---------------------------------------------------------------------
  const apiLimiter = createRateLimiter({ max: rateLimit.max ?? 600, windowMs: rateLimit.windowMs });
  const writeLimiter = createRateLimiter({ max: rateLimit.writeMax ?? 60, windowMs: rateLimit.windowMs });
  app.use('/api', apiLimiter);
  app.use(express.json({ limit: '10kb' }));

  app.get('/api/health', (req, res) => res.json({ status: 'ok', pod: buildInfo.pod }));
  app.get('/api/version', (req, res) => res.json(buildInfo));

  app.get('/api/stats', (req, res) => {
    res.json({
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      requests: requestCount,
      items: store.size,
      pod: buildInfo.pod,
    });
  });

  app.get('/api/spec', (req, res) => {
    const { spec, hash } = specProvider.get();
    res.json({ hash, spec });
  });

  // ---- items (catalog CRUD) ----------------------------------------------------
  const parseId = (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'id must be a positive integer' });
    req.itemId = id;
    next();
  };

  // Writes are only accepted when the spec opts in; otherwise a public deployment
  // would let anyone modify (per-pod, in-memory) data.
  const requireWritesEnabled = (req, res, next) => {
    if (!specProvider.get().spec.catalog.allowEdit) {
      return res.status(403).json({ error: 'writes are disabled (set catalog.allowEdit: true in the spec)' });
    }
    next();
  };

  app.get('/api/items', (req, res) => res.json(store.list()));

  app.get('/api/items/:id', parseId, (req, res) => {
    const item = store.get(req.itemId);
    if (!item) return res.status(404).json({ error: 'item not found' });
    res.json(item);
  });

  app.post('/api/items', writeLimiter, requireWritesEnabled, (req, res) => {
    const { value, errors } = validateItemInput(req.body);
    if (errors) return res.status(400).json({ error: 'validation failed', details: errors });
    res.status(201).json(store.create(value));
  });

  app.put('/api/items/:id', writeLimiter, requireWritesEnabled, parseId, (req, res) => {
    const { value, errors } = validateItemInput(req.body, { partial: true });
    if (errors) return res.status(400).json({ error: 'validation failed', details: errors });
    const item = store.update(req.itemId, value);
    if (!item) return res.status(404).json({ error: 'item not found' });
    res.json(item);
  });

  app.delete('/api/items/:id', writeLimiter, requireWritesEnabled, parseId, (req, res) => {
    if (!store.delete(req.itemId)) return res.status(404).json({ error: 'item not found' });
    res.status(204).end();
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  // ---- optional static frontend (local dev; in the cluster nginx does this) ------
  // No existsSync() pre-check (check-then-use race): enabling is purely config-driven and
  // a missing file/dir is handled by the operations themselves (static falls through, sendFile errors -> 404).
  if (frontendDir) {
    const root = path.resolve(frontendDir);
    app.use((req, res, next) => {
      res.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
      next();
    });
    app.use(express.static(root, { etag: false, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
    app.use((req, res) => {
      res.sendFile('index.html', { root }, (err) => {
        if (err && !res.headersSent) res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: 'frontend not available' });
      });
    });
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large' });
    log({ level: 'error', msg: 'unhandled error', error: err.message, stack: err.stack });
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

module.exports = { createApp, readBuildInfo, CONTENT_SECURITY_POLICY };
