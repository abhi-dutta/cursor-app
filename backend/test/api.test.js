'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createApp } = require('../src/app');
const { SpecProvider } = require('../src/spec');
const { ItemStore } = require('../src/store');

/**
 * Starts the app on an ephemeral port.
 * `allowEdit` overrides catalog.allowEdit from the shipped spec (default: true so CRUD can be tested).
 */
async function withServer(fn, { state, frontendDir, allowEdit = true, rateLimit, reportIncident, items } = {}) {
  const real = new SpecProvider();
  const { spec, hash } = real.get();
  const specProvider = { get: () => ({ hash, spec: { ...spec, catalog: { ...spec.catalog, allowEdit } } }) };
  const store = new ItemStore(items || spec.catalog.items);
  const app = createApp({
    specProvider,
    store,
    state,
    frontendDir,
    rateLimit,
    reportIncident,
    log: () => {},
    buildInfo: { service: 'backend', version: 'test', commit: 'abc123', environment: 'test', pod: 'test-pod' },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const json = (body, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('health and readiness probes', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  });
});

test('readiness fails while draining', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
  }, { state: { ready: false } });
});

test('GET /api/version returns build info and no runtime internals', async () => {
  await withServer(async (base) => {
    const body = await (await fetch(`${base}/api/version`)).json();
    assert.equal(body.version, 'test');
    assert.equal(body.pod, 'test-pod');
    assert.equal(body.node, undefined);
  });
});

test('responses carry hardening headers and API responses are not cached', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/version`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});

test('GET /api/spec returns the spec and its hash', async () => {
  await withServer(async (base) => {
    const body = await (await fetch(`${base}/api/spec`)).json();
    assert.match(body.hash, /^[0-9a-f]{8}$/);
    assert.ok(body.spec.hero.title);
    assert.ok(Array.isArray(body.spec.sections));
  });
});

test('GET /api/stats counts API requests and items', async () => {
  await withServer(async (base) => {
    await fetch(`${base}/api/items`);
    const stats = await (await fetch(`${base}/api/stats`)).json();
    assert.ok(stats.requests >= 2);
    assert.equal(stats.items, 4);
  });
});

test('a 500 is reported after the response, and a successful request is not', async () => {
  const calls = [];
  await withServer(async (base) => {
    const started = Date.now();
    const failed = await fetch(`${base}/api/items/5/badge`);
    assert.equal(failed.status, 500);
    assert.ok(Date.now() - started < 500);
    assert.equal((await fetch(`${base}/api/items/1/badge`)).status, 200);
    const badJson = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal(badJson.status, 400);
  }, {
    allowEdit: true,
    // item 5 is malformed (no price) so the badge route throws and a 500 is produced
    items: [{ id: 1, name: 'Ok', price: 1 }, { id: 5, name: 'Broken' }],
    reportIncident: (err, req, context) => {
      calls.push({ name: err.name, route: `${req.method} ${req.baseUrl || ''}${req.route.path}`, context });
      return new Promise(() => {});
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'TypeError');
  assert.equal(calls[0].route, 'GET /api/items/:id/badge');
  assert.equal(calls[0].context.version, 'test');
  assert.equal(calls[0].context.pod, 'test-pod');
  assert.match(calls[0].context.specHash, /^[0-9a-f]{8}$/);
});

test('GET /api/items/:id/badge formats a tagged item', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/items/1/badge`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).badge, 'POPULAR · Pipeline Starter Kit · $49.00');
    assert.equal((await fetch(`${base}/api/items/99/badge`)).status, 404);
  });
});

test('GET /api/items/:id/badge works for an item without a tag (SCRUM-16)', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/items/3/badge`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).badge, 'Feature Flag Pack · $29.00');
  });
});

test('items CRUD lifecycle (writes enabled)', async () => {
  await withServer(async (base) => {
    const list = await (await fetch(`${base}/api/items`)).json();
    assert.equal(list.length, 4);

    const created = await fetch(`${base}/api/items`, json({ name: 'Gadget', price: 12.5, emoji: '🛠️' }));
    assert.equal(created.status, 201);
    const item = await created.json();
    assert.equal(item.name, 'Gadget');
    assert.ok(item.id > 4);

    const fetched = await (await fetch(`${base}/api/items/${item.id}`)).json();
    assert.equal(fetched.price, 12.5);

    const updated = await fetch(`${base}/api/items/${item.id}`, json({ price: 20 }, 'PUT'));
    assert.equal((await updated.json()).price, 20);

    assert.equal((await fetch(`${base}/api/items/${item.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${base}/api/items/${item.id}`)).status, 404);
  });
});

test('writes are rejected with 403 unless the spec enables them', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/items`)).status, 200); // reads still work
    assert.equal((await fetch(`${base}/api/items`, json({ name: 'x', price: 1 }))).status, 403);
    assert.equal((await fetch(`${base}/api/items/1`, json({ price: 1 }, 'PUT'))).status, 403);
    assert.equal((await fetch(`${base}/api/items/1`, { method: 'DELETE' })).status, 403);
    const list = await (await fetch(`${base}/api/items`)).json();
    assert.equal(list.length, 4);
  }, { allowEdit: false });
});

test('item validation and error handling', async () => {
  await withServer(async (base) => {
    const bad = await fetch(`${base}/api/items`, json({ name: '', price: -1 }));
    assert.equal(bad.status, 400);
    assert.ok((await bad.json()).details.length >= 2);

    const malformed = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    assert.equal(malformed.status, 400);

    assert.equal((await fetch(`${base}/api/items/abc`)).status, 400);
    assert.equal((await fetch(`${base}/api/items/9999`)).status, 404);
    assert.equal((await fetch(`${base}/api/unknown`)).status, 404);

    const huge = await fetch(`${base}/api/items`, json({ name: 'x'.repeat(20_000), price: 1 }));
    assert.equal(huge.status, 413);
  });
});

test('rate limiting returns 429 with Retry-After, and probes are exempt', async () => {
  await withServer(async (base) => {
    for (let i = 0; i < 3; i += 1) assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const limited = await fetch(`${base}/api/health`);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
  }, { rateLimit: { max: 3, windowMs: 60_000 } });
});

test('write rate limit is stricter than the general limit', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/items`, json({ name: 'a', price: 1 }))).status, 201);
    assert.equal((await fetch(`${base}/api/items`, json({ name: 'b', price: 1 }))).status, 201);
    assert.equal((await fetch(`${base}/api/items`, json({ name: 'c', price: 1 }))).status, 429);
    assert.equal((await fetch(`${base}/api/items`)).status, 200);
  }, { rateLimit: { max: 100, writeMax: 2, windowMs: 60_000 } });
});

test('forwarded-IP headers are ignored: a spoofed address can neither dodge nor split the limit', async () => {
  await withServer(async (base) => {
    const hit = (headers) => fetch(`${base}/api/health`, { headers }).then((r) => r.status);
    assert.equal(await hit({ 'x-forwarded-for': '203.0.113.1' }), 200);
    // Different spoofed identities all share the real peer's budget.
    assert.equal(await hit({ 'x-forwarded-for': '203.0.113.2' }), 429);
    assert.equal(await hit({ 'x-real-ip': '203.0.113.3' }), 429);
    assert.equal(await hit({ forwarded: 'for=203.0.113.4' }), 429);
    assert.equal(await hit({}), 429);
  }, { rateLimit: { max: 1, windowMs: 60_000 } });
});

test('request logs record the socket peer, not a client-supplied header', async () => {
  const entries = [];
  const specProvider = new SpecProvider();
  const app = createApp({
    specProvider,
    store: new ItemStore([]),
    log: (e) => entries.push(e),
    buildInfo: { pod: 'p' },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    await fetch(`http://127.0.0.1:${server.address().port}/api/health`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    await new Promise((r) => setTimeout(r, 20));
    const entry = entries.find((e) => e.msg === 'request');
    assert.match(entry.peer, /127\.0\.0\.1$/);
    assert.ok(!JSON.stringify(entry).includes('203.0.113.9'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('static frontend: serves assets, CSP and SPA fallback when the directory exists', async () => {
  const dir = path.resolve(__dirname, '../../frontend/public');
  await withServer(async (base) => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(await index.text(), /<div id="app"/);
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/some/client/route`)).status, 200);
    assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
  }, { frontendDir: dir });
});

test('static frontend: a missing directory yields a clean 404, not a crash', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'frontend not available');
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  }, { frontendDir: '/nonexistent/frontend-dir' });
});
