'use strict';

const crypto = require('node:crypto');

const MAX_TEXT = 2000;
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;
const PROJECT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{1,19}$/;

const clip = (value) => {
  const text = String(value ?? '');
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
};

/**
 * Reduce a stack to "function file.js", dropping line numbers and directories
 * so the same bug keeps the same fingerprint across builds and machines.
 */
function frameKey(stack) {
  const lines = String(stack || '').split('\n').map((line) => line.trim()).filter((line) => line.startsWith('at '));
  const own = lines.find((line) => !line.includes('node_modules') && !line.includes('node:')) || '';
  if (!own) return 'unknown';

  let fn = 'anonymous';
  let location = own.slice(3);
  const withFn = own.match(/^at\s+(?:async\s+)?(.+?)\s+\((.+)\)$/);
  if (withFn) {
    fn = withFn[1];
    location = withFn[2];
  } else {
    const bare = own.match(/^at\s+(?:async\s+)?(.+)$/);
    if (bare) location = bare[1];
  }
  const file = location.match(/([^/\\]+):\d+:\d+$/) || location.match(/([^/\\]+)$/);
  return `${fn} ${file ? file[1] : 'unknown'}`;
}

function fingerprintOf(errName, stack) {
  return crypto.createHash('sha256').update(`${errName}\n${frameKey(stack)}`).digest('hex').slice(0, 8);
}

function routeOf(req) {
  const path = req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : (req.path || '');
  return `${req.method || ''} ${path}`.trim();
}

const text = (value) => ({ type: 'text', text: value });
const paragraph = (value) => ({ type: 'paragraph', content: [text(value)] });

/** Atlassian Document Format body listing the incident facts and the stack. */
function describeIncident(incident) {
  const facts = [
    ['Fingerprint', incident.fingerprint],
    ['Route', incident.route],
    ['Error', `${incident.errName}: ${incident.error}`],
    ['Request ID', incident.requestId],
    ['App version', incident.appVersion],
    ['Git SHA', incident.gitSha],
    ['Pod', incident.pod],
    ['Spec hash', incident.specHash],
    ['Environment', incident.environment],
  ].filter(([, value]) => value);
  return {
    type: 'doc',
    version: 1,
    content: [
      paragraph('Unhandled 500 captured automatically by the backend.'),
      {
        type: 'bulletList',
        content: facts.map(([label, value]) => ({
          type: 'listItem',
          content: [paragraph(`${label}: ${value}`)],
        })),
      },
      { type: 'codeBlock', content: [text(incident.stack || 'no stack available')] },
    ],
  };
}

function commentBody(incident) {
  return {
    type: 'doc',
    version: 1,
    content: [
      paragraph(`Seen again on ${incident.route} (request ${incident.requestId || 'n/a'}, pod ${incident.pod || 'n/a'}, version ${incident.appVersion || 'n/a'}).`),
    ],
  };
}

/**
 * Reports unhandled 500s to Jira Cloud through the REST API (v3):
 * look for an open issue labelled fp-<fingerprint>, comment on it if found,
 * otherwise create a Task. Fire-and-forget; never throws to the caller and
 * never logs the API token. At most one report per fingerprint per cooldown,
 * including when Jira is unreachable.
 */
function createIncidentReporter({
  baseUrl = '',
  email = '',
  apiToken = '',
  projectKey = '',
  issueType = 'Task',
  enabled = false,
  log = () => {},
  fetchImpl = globalThis.fetch,
  now = Date.now,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const lastSent = new Map();
  const root = String(baseUrl || '').replace(/\/+$/, '');
  const active = enabled === true
    && /^https:\/\//.test(root)
    && String(email).length > 0
    && String(apiToken).length > 0
    && PROJECT_KEY_PATTERN.test(String(projectKey));
  const authorization = active
    ? `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`
    : '';

  const redact = (message) => [apiToken, authorization, authorization.replace(/^Basic /, '')]
    .filter(Boolean)
    .reduce((out, secret) => out.split(secret).join('[redacted]'), String(message));

  async function call(path, body, signal) {
    const res = await fetchImpl(`${root}/rest/api/3${path}`, {
      method: 'POST',
      headers: {
        authorization,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res || res.ok === false) throw new Error(`jira ${path} status ${res?.status}`);
    return typeof res.json === 'function' ? res.json() : {};
  }

  async function deliver(incident, signal) {
    const label = `fp-${incident.fingerprint}`;
    const found = await call('/search/jql', {
      jql: `project = "${projectKey}" AND labels = "${label}" AND statusCategory != Done ORDER BY created DESC`,
      fields: ['summary'],
      maxResults: 1,
    }, signal);
    const existing = Array.isArray(found?.issues) ? found.issues[0] : undefined;
    if (existing?.key) {
      await call(`/issue/${encodeURIComponent(existing.key)}/comment`, { body: commentBody(incident) }, signal);
      return;
    }
    await call('/issue', {
      fields: {
        project: { key: projectKey },
        issuetype: { name: issueType },
        summary: `[auto] ${incident.errName} in ${incident.route}`.slice(0, 250),
        labels: ['incident', 'auto-created', label],
        description: describeIncident(incident),
      },
    }, signal);
  }

  return function reportIncident(err, req, context = {}) {
    if (!active) return;
    const errName = err?.name || 'Error';
    const stack = err?.stack || '';
    const fingerprint = fingerprintOf(errName, stack);
    const at = now();
    const previous = lastSent.get(fingerprint);
    if (previous !== undefined && at - previous < cooldownMs) return;
    lastSent.set(fingerprint, at);

    const incident = {
      errName,
      error: clip(err?.message),
      fingerprint,
      route: routeOf(req),
      requestId: req?.id || '',
      appVersion: context.version || '',
      gitSha: context.commit || '',
      pod: context.pod || '',
      specHash: context.specHash || '',
      environment: context.environment || '',
      stack: clip(stack),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    deliver(incident, controller.signal)
      .catch((failure) => {
        log({ level: 'warn', msg: 'incident report failed', error: redact(failure?.message || failure) });
      })
      .finally(() => clearTimeout(timer));
  };
}

module.exports = { createIncidentReporter, describeIncident, fingerprintOf, frameKey, routeOf };
