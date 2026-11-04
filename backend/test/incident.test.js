'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createIncidentReporter, fingerprintOf } = require('../src/incident');

const WEBHOOK_URL = 'https://automation.example/hooks/example-hook';

function stackAt(line) {
  return [
    'TypeError: Cannot read properties of undefined (reading \'toUpperCase\')',
    `    at badgeText (/srv/app/backend/src/badge.js:${line}:25)`,
    '    at /srv/app/backend/src/app.js:149:23',
    '    at Layer.handleRequest (/srv/app/backend/node_modules/router/lib/layer.js:152:17)',
  ].join('\n');
}

function boom(line = 5) {
  const err = new TypeError("Cannot read properties of undefined (reading 'toUpperCase')");
  err.stack = stackAt(line);
  return err;
}

const req = { id: 'abc', method: 'GET', baseUrl: '', route: { path: '/api/items/:id/badge' }, path: '/api/items/3/badge' };

test('a missing URL or a disabled reporter never calls fetch', async () => {
  let calls = 0;
  const fetchImpl = () => { calls += 1; return Promise.resolve({ ok: true }); };
  createIncidentReporter({ url: '', enabled: true, fetchImpl })(boom(), req);
  createIncidentReporter({ url: WEBHOOK_URL, enabled: false, fetchImpl })(boom(), req);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 0);
});

test('the webhook body carries the incident and not the webhook URL', async () => {
  let body;
  const fetchImpl = (_url, opts) => {
    body = JSON.parse(opts.body);
    return Promise.resolve({ ok: true });
  };
  createIncidentReporter({ url: WEBHOOK_URL, enabled: true, fetchImpl })(boom(), req, {
    version: '1.2.3', commit: 'abc123', pod: 'backend-1', environment: 'dev', specHash: 'deadbeef',
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(body.errName, 'TypeError');
  assert.equal(body.route, 'GET /api/items/:id/badge');
  assert.equal(body.requestId, 'abc');
  assert.equal(body.appVersion, '1.2.3');
  assert.equal(body.gitSha, 'abc123');
  assert.equal(body.pod, 'backend-1');
  assert.equal(body.environment, 'dev');
  assert.equal(body.specHash, 'deadbeef');
  assert.match(body.fingerprint, /^[0-9a-f]{8}$/);
  assert.equal(JSON.stringify(body).includes('example-hook'), false);
});

test('the same fingerprint is skipped until the cooldown passes', async () => {
  let now = 1_000;
  let calls = 0;
  const fetchImpl = () => { calls += 1; return Promise.resolve({ ok: true }); };
  const report = createIncidentReporter({
    url: WEBHOOK_URL, enabled: true, fetchImpl, now: () => now, cooldownMs: 1_000,
  });
  report(boom(5), req);
  report(boom(80), req);
  now += 1_000;
  report(boom(5), req);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 2);
});

test('line numbers do not change the fingerprint', () => {
  assert.equal(fingerprintOf('TypeError', stackAt(5)), fingerprintOf('TypeError', stackAt(90)));
  assert.notEqual(fingerprintOf('TypeError', stackAt(5)), fingerprintOf('RangeError', stackAt(5)));
});

test('a failed webhook is logged without the URL', async () => {
  const entries = [];
  const fetchImpl = () => Promise.reject(new Error(`connect ${WEBHOOK_URL} refused`));
  createIncidentReporter({
    url: WEBHOOK_URL,
    enabled: true,
    fetchImpl,
    log: (entry) => entries.push(entry),
  })(boom(), req);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].msg, 'incident report failed');
  assert.equal(JSON.stringify(entries[0]).includes('example-hook'), false);
  assert.equal(JSON.stringify(entries[0]).includes(WEBHOOK_URL), false);
});
