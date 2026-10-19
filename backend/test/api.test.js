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
async function withServer(fn, { state, frontendDir, allowEdit = true, rateLimit, trustedProxies } = {}) {
  const real = new SpecProvider();
  const { spec, hash } = real.get();
  const specProvider = { get: () => ({ hash, spec: { ...spec, catalog: { ...spec.catalog, allowEdit } } }) };
  const store = new ItemStore(spec.catalog.items);
  const app = createApp({
    specProvider,
    store,
    state,
    frontendDir,
    rateLimit,
    trustedProxies,
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

test('X-Forwarded-For is honoured only when the direct peer is a trusted proxy', async () => {
  const limit = { max: 1, windowMs: 60_000 };
  const hit = (base, ip) => fetch(`${base}/api/health`, { headers: { 'x-forwarded-for': ip } }).then((r) => r.status);

  // Peer (127.0.0.1) is trusted: forwarded IPs get separate budgets.
  await withServer(async (base) => {
    assert.equal(await hit(base, '203.0.113.1'), 200);
    assert.equal(await hit(base, '203.0.113.1'), 429);
    assert.equal(await hit(base, '203.0.113.2'), 200);
  }, { rateLimit: limit, trustedProxies: ['127.0.0.1'] });

  // Named range works too.
  await withServer(async (base) => {
    assert.equal(await hit(base, '203.0.113.1'), 200);
    assert.equal(await hit(base, '203.0.113.2'), 200);
  }, { rateLimit: limit, trustedProxies: ['loopback'] });
});

test('a spoofed X-Forwarded-For cannot dodge the limit from an untrusted peer', async () => {
  const limit = { max: 1, windowMs: 60_000 };
  const hit = (base, ip) => fetch(`${base}/api/health`, { headers: { 'x-forwarded-for': ip } }).then((r) => r.status);
  const untrusted = [
    { rateLimit: limit },                                              // nobody trusted (default)
    { rateLimit: limit, trustedProxies: [] },
    { rateLimit: limit, trustedProxies: ['10.0.0.0/8'] },              // peer 127.0.0.1 not in the list
    { rateLimit: limit, trustedProxies: ['198.51.100.7'] },
  ];
  for (const options of untrusted) {
    await withServer(async (base) => {
      assert.equal(await hit(base, '203.0.113.1'), 200);
      assert.equal(await hit(base, '203.0.113.2'), 429); // header ignored: same client
      assert.equal(await hit(base, '203.0.113.3'), 429);
    }, options);
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
