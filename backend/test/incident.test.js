'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createIncidentReporter, fingerprintOf, stampOf, summaryOf } = require('../src/incident');

const JIRA = {
  baseUrl: 'https://jira.example.test/',
  email: 'bot@example.test',
  apiToken: 'example-credential-1',
  projectKey: 'DEMO',
  enabled: true,
};
const AUTH = `Basic ${Buffer.from(`${JIRA.email}:${JIRA.apiToken}`).toString('base64')}`;

/** Fake Jira: records calls; `open` is the issue list the search returns. */
function fakeJira({ open = [], fail = null } = {}) {
  const calls = [];
  const fetchImpl = (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, headers: opts.headers, body });
    if (fail) return Promise.reject(fail);
    const json = url.endsWith('/search/jql') ? { issues: open } : { key: 'DEMO-9' };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(json) });
  };
  return { calls, fetchImpl };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

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

test('an incomplete config or a disabled reporter never calls fetch', async () => {
  const jira = fakeJira();
  const fetchImpl = jira.fetchImpl;
  createIncidentReporter({ ...JIRA, enabled: false, fetchImpl })(boom(), req);
  createIncidentReporter({ ...JIRA, apiToken: '', fetchImpl })(boom(), req);
  createIncidentReporter({ ...JIRA, email: '', fetchImpl })(boom(), req);
  createIncidentReporter({ ...JIRA, projectKey: 'bad key"', fetchImpl })(boom(), req);
  createIncidentReporter({ ...JIRA, baseUrl: 'http://insecure.example.test', fetchImpl })(boom(), req);
  await settle();
  assert.equal(jira.calls.length, 0);
});

test('a new fingerprint searches Jira, then creates a labelled Task', async () => {
  const jira = fakeJira();
  const clock = Date.UTC(2026, 10, 12, 13, 45, 7);
  createIncidentReporter({ ...JIRA, fetchImpl: jira.fetchImpl, now: () => clock })(boom(), req, {
    version: '1.2.3', commit: 'abc123', pod: 'backend-1', environment: 'dev', specHash: 'deadbeef',
  });
  await settle();
  assert.equal(jira.calls.length, 2);

  const [search, create] = jira.calls;
  const fingerprint = fingerprintOf('TypeError', stackAt(5));
  assert.equal(search.url, 'https://jira.example.test/rest/api/3/search/jql');
  assert.match(search.body.jql, new RegExp(`labels = "fp-${fingerprint}"`));
  assert.match(search.body.jql, /project = "DEMO"/);
  assert.match(search.body.jql, /statusCategory != Done/);
  assert.deepEqual(search.body.fields, ['summary']);

  assert.equal(create.url, 'https://jira.example.test/rest/api/3/issue');
  assert.equal(create.headers.authorization, AUTH);
  const { fields } = create.body;
  assert.deepEqual(fields.project, { key: 'DEMO' });
  assert.deepEqual(fields.issuetype, { name: 'Task' });
  assert.equal(fields.summary, '[auto] TypeError in GET /api/items/:id/badge (2026-11-12 13:45:07 UTC)');
  assert.deepEqual(fields.labels, ['incident', 'auto-created', `fp-${fingerprint}`]);
  assert.equal(fields.description.type, 'doc');
  const description = JSON.stringify(fields.description);
  for (const expected of ['2026-11-12 13:45:07 UTC', fingerprint, 'abc123', 'backend-1', 'deadbeef', 'badge.js', 'abc']) {
    assert.ok(description.includes(expected), `description mentions ${expected}`);
  }
  assert.equal(JSON.stringify(create.body).includes(JIRA.apiToken), false);
});

test('an open issue for the fingerprint gets a comment instead of a new Task', async () => {
  const jira = fakeJira({ open: [{ id: '1', key: 'DEMO-4' }] });
  createIncidentReporter({ ...JIRA, fetchImpl: jira.fetchImpl })(boom(), req, { pod: 'backend-2' });
  await settle();
  assert.equal(jira.calls.length, 2);
  assert.equal(jira.calls[1].url, 'https://jira.example.test/rest/api/3/issue/DEMO-4/comment');
  assert.equal(jira.calls[1].body.body.type, 'doc');
  assert.ok(JSON.stringify(jira.calls[1].body).includes('backend-2'));
  assert.equal(jira.calls.some((c) => c.url.endsWith('/rest/api/3/issue')), false);
});

test('the same fingerprint is skipped until the cooldown passes', async () => {
  let now = 1_000;
  const jira = fakeJira();
  const report = createIncidentReporter({
    ...JIRA, fetchImpl: jira.fetchImpl, now: () => now, cooldownMs: 1_000,
  });
  report(boom(5), req);
  report(boom(80), req);
  now += 1_000;
  report(boom(5), req);
  await settle();
  assert.equal(jira.calls.length, 4);
});

test('the summary carries a UTC timestamp and stays within the Jira limit', () => {
  assert.equal(stampOf(Date.UTC(2026, 0, 2, 3, 4, 5)), '2026-01-02 03:04:05 UTC');
  const long = summaryOf({ errName: 'TypeError', route: `GET /${'x'.repeat(400)}`, at: '2026-01-02 03:04:05 UTC' });
  assert.equal(long.length, 250);
  assert.ok(long.endsWith(' (2026-01-02 03:04:05 UTC)'));
});

test('line numbers do not change the fingerprint', () => {
  assert.equal(fingerprintOf('TypeError', stackAt(5)), fingerprintOf('TypeError', stackAt(90)));
  assert.notEqual(fingerprintOf('TypeError', stackAt(5)), fingerprintOf('RangeError', stackAt(5)));
});

test('a failing Jira is logged without the token or auth header', async () => {
  const entries = [];
  const jira = fakeJira({ fail: new Error(`401 for ${AUTH} token ${JIRA.apiToken}`) });
  createIncidentReporter({
    ...JIRA,
    fetchImpl: jira.fetchImpl,
    log: (entry) => entries.push(entry),
  })(boom(), req);
  await settle();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].msg, 'incident report failed');
  const logged = JSON.stringify(entries[0]);
  assert.equal(logged.includes(JIRA.apiToken), false);
  assert.equal(logged.includes(AUTH), false);
  assert.equal(logged.includes(AUTH.replace('Basic ', '')), false);
});

test('a non-2xx answer from Jira is logged and does not throw', async () => {
  const entries = [];
  const fetchImpl = () => Promise.resolve({ ok: false, status: 403 });
  assert.doesNotThrow(() => createIncidentReporter({
    ...JIRA, fetchImpl, log: (entry) => entries.push(entry),
  })(boom(), req));
  await settle();
  assert.equal(entries.length, 1);
  assert.match(entries[0].error, /status 403/);
});
