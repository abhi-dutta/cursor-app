'use strict';

const net = require('node:net');

// Express' built-in named ranges
const NAMED = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * Parses the TRUSTED_PROXIES setting: a comma separated list of IPs, CIDRs or the Express
 * names `loopback`, `linklocal`, `uniquelocal` (10/8, 172.16/12, 192.168/16, fc00::/7).
 *
 * X-Forwarded-For is only honoured when the *direct* peer is in this list, so a client that
 * connects straight to the app cannot spoof its address. An empty/unset value trusts no one
 * and `req.ip` is always the socket peer address. A bare hop count is deliberately NOT
 * supported: it would trust the header from any peer.
 */
function parseTrustedProxies(value) {
  if (value === undefined || value === null || String(value).trim() === '') return [];
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (NAMED.has(entry)) return entry;
      const [address, prefix, ...rest] = entry.split('/');
      const family = net.isIP(address);
      const maxPrefix = family === 4 ? 32 : 128;
      const prefixOk = prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= maxPrefix);
      if (!family || rest.length > 0 || !prefixOk) {
        throw new Error(`TRUSTED_PROXIES: "${entry}" is not an IP, CIDR, loopback, linklocal or uniquelocal`);
      }
      return entry;
    });
}

module.exports = { parseTrustedProxies };
