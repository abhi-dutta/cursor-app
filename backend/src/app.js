'use strict';

const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { validateItemInput } = require('./store');

function readBuildInfo(env = process.env) {
  return {
    service: 'backend',
    version: env.APP_VERSION || 'dev',
    commit: env.GIT_SHA || 'local',
    buildTime: env.BUILD_TIME || 'unknown',
    environment: env.APP_ENVIRONMENT || 'local',
    pod: env.HOSTNAME || os.hostname(),
    node: process.version,
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
 */
function createApp({ specProvider, store, buildInfo = readBuildInfo(), frontendDir, state = { ready: true } }) {
  const app = express();
  const startedAt = Date.now();
  let requestCount = 0;

  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    if (req.path.startsWith('/api/')) {
      requestCount += 1;
      res.set('Cache-Control', 'no-store');
    }
    next();
  });

  // ---- health (used by Kubernetes probes) ---------------------------------
  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', (req, res) => {
    if (!state.ready) return res.status(503).json({ status: 'draining' });
    specProvider.get();
    res.json({ status: 'ready' });
  });
  app.get('/api/health', (req, res) => res.json({ status: 'ok', pod: buildInfo.pod }));

  // ---- metadata -------------------------------------------------------------
  app.get('/api/version', (req, res) => res.json(buildInfo));

  app.get('/api/stats', (req, res) => {
    res.json({
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      requests: requestCount,
      items: store.size,
      pod: buildInfo.pod,
    });
  });

  // ---- spec -----------------------------------------------------------------
  app.get('/api/spec', (req, res) => {
    const { spec, hash } = specProvider.get();
    res.json({ hash, spec });
  });

  // ---- items (catalog CRUD) -------------------------------------------------
  const parseId = (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'id must be a positive integer' });
    req.itemId = id;
    next();
  };

  app.get('/api/items', (req, res) => res.json(store.list()));

  app.get('/api/items/:id', parseId, (req, res) => {
    const item = store.get(req.itemId);
    if (!item) return res.status(404).json({ error: 'item not found' });
    res.json(item);
  });

  app.post('/api/items', (req, res) => {
    const { value, errors } = validateItemInput(req.body);
    if (errors) return res.status(400).json({ error: 'validation failed', details: errors });
    res.status(201).json(store.create(value));
  });

  app.put('/api/items/:id', parseId, (req, res) => {
    const { value, errors } = validateItemInput(req.body, { partial: true });
    if (errors) return res.status(400).json({ error: 'validation failed', details: errors });
    const item = store.update(req.itemId, value);
    if (!item) return res.status(404).json({ error: 'item not found' });
    res.json(item);
  });

  app.delete('/api/items/:id', parseId, (req, res) => {
    if (!store.delete(req.itemId)) return res.status(404).json({ error: 'item not found' });
    res.status(204).end();
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  // ---- optional static frontend (local dev; in the cluster nginx does this) --
  // No existsSync() pre-check (check-then-use race): enabling is purely config-driven and
  // a missing file/dir is handled by the operations themselves (static falls through, sendFile errors -> 404).
  if (frontendDir) {
    const root = path.resolve(frontendDir);
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
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

module.exports = { createApp, readBuildInfo };
