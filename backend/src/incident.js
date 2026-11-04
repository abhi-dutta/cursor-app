'use strict';

const crypto = require('node:crypto');

const MAX_TEXT = 2000;
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 2000;

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
  return crypto.createHash('sha1').update(`${errName}\n${frameKey(stack)}`).digest('hex').slice(0, 8);
}

function routeOf(req) {
  const path = req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : (req.path || '');
  return `${req.method || ''} ${path}`.trim();
}

/**
 * Fire-and-forget POST to a Jira Automation incoming webhook.
 * No-op unless enabled and a URL is set. Never throws to the caller.
 * One report per fingerprint per cooldown, including when the POST fails.
 */
function createIncidentReporter({
  url = '',
  enabled = false,
  log = () => {},
  fetchImpl = globalThis.fetch,
  now = Date.now,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const lastSent = new Map();
  const active = enabled === true && typeof url === 'string' && url.length > 0;

  return function reportIncident(err, req, context = {}) {
    if (!active) return;
    const errName = err?.name || 'Error';
    const stack = err?.stack || '';
    const fingerprint = fingerprintOf(errName, stack);
    const at = now();
    const previous = lastSent.get(fingerprint);
    if (previous !== undefined && at - previous < cooldownMs) return;
    lastSent.set(fingerprint, at);

    const payload = {
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
    Promise.resolve().then(() => fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })).then((res) => {
      if (res && res.ok === false) throw new Error(`webhook status ${res.status}`);
    }).catch((failure) => {
      const message = String(failure?.message || failure).split(url).join('[webhook]');
      log({ level: 'warn', msg: 'incident report failed', error: message });
    }).finally(() => clearTimeout(timer));
  };
}

module.exports = { createIncidentReporter, fingerprintOf, frameKey, routeOf };
