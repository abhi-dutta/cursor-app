'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTrustedProxies } = require('../src/trusted-proxies');

test('unset or blank trusts nobody', () => {
  assert.deepEqual(parseTrustedProxies(undefined), []);
  assert.deepEqual(parseTrustedProxies(''), []);
  assert.deepEqual(parseTrustedProxies('  , ,'), []);
});

test('accepts IPs, CIDRs and the named Express ranges', () => {
  assert.deepEqual(
    parseTrustedProxies('10.0.0.0/8, 192.168.1.5 ,loopback,uniquelocal,linklocal,fd00::/8,::1'),
    ['10.0.0.0/8', '192.168.1.5', 'loopback', 'uniquelocal', 'linklocal', 'fd00::/8', '::1'],
  );
});

test('rejects a bare hop count and other malformed entries', () => {
  // A hop count would trust X-Forwarded-For from any peer, which is exactly what we must not allow.
  for (const bad of ['1', '2', 'true', 'all', '10.0.0.0/33', '10.0.0.0/x', '10.0.0.0/8/8', 'not-an-ip', '999.1.1.1', 'fd00::/129']) {
    assert.throws(() => parseTrustedProxies(bad), /TRUSTED_PROXIES/, `expected "${bad}" to be rejected`);
  }
});
