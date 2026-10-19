'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { SpecProvider } = require('../src/spec');
const { ItemStore } = require('../src/store');

async function withServer(fn, { state, frontendDir } = {}) {
  const specProvider = new SpecProvider();
  const store = new ItemStore(specProvider.get().spec.catalog.items);
  const app = createApp({
    specProvider,
    store,
    state,
    frontendDir,
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

const json = (body) => ({
  method: 'POST',
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

test('GET /api/version returns build info', async () => {
  await withServer(async (base) => {
    const body = await (await fetch(`${base}/api/version`)).json();
    assert.equal(body.version, 'test');
    assert.equal(body.pod, 'test-pod');
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

test('items CRUD lifecycle', async () => {
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

    const updated = await fetch(`${base}/api/items/${item.id}`, { ...json({ price: 20 }), method: 'PUT' });
    assert.equal((await updated.json()).price, 20);

    assert.equal((await fetch(`${base}/api/items/${item.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${base}/api/items/${item.id}`)).status, 404);
  });
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
  });
});

test('static frontend: serves assets and SPA fallback when the directory exists', async () => {
  const dir = require('node:path').resolve(__dirname, '../../frontend/public');
  await withServer(async (base) => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
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
