'use strict';

const path = require('node:path');
const { createApp, readBuildInfo } = require('./app');
const { SpecProvider, DEFAULT_SPEC_PATH } = require('./spec');
const { ItemStore } = require('./store');

const port = Number(process.env.PORT) || 3000;
const specPath = process.env.SPEC_PATH || DEFAULT_SPEC_PATH;
const watch = process.env.SPEC_WATCH === 'true';
const frontendDir = process.env.SERVE_FRONTEND ? path.resolve(process.cwd(), process.env.SERVE_FRONTEND) : undefined;

let specProvider;
try {
  specProvider = new SpecProvider(specPath, { watch });
} catch (err) {
  console.error(`[startup] cannot load spec at ${specPath}\n${err.message}`);
  process.exit(1);
}

const store = new ItemStore(specProvider.get().spec.catalog.items);
const state = { ready: true };
const buildInfo = readBuildInfo();
const app = createApp({ specProvider, store, buildInfo, frontendDir, state });

const server = app.listen(port, () => {
  console.log(`[startup] backend ${buildInfo.version} (${buildInfo.commit}) listening on :${port}`);
  console.log(`[startup] spec=${specPath} hash=${specProvider.get().hash} watch=${watch}`);
  if (frontendDir) console.log(`[startup] serving frontend from ${frontendDir}`);
});

// Graceful shutdown: fail readiness, stop accepting connections and exit once
// in-flight requests finish. (The k8s preStop hook already waits for the endpoint
// to be removed from the Service before SIGTERM arrives.)
function shutdown(signal) {
  console.log(`[shutdown] ${signal} received, draining`);
  state.ready = false;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 25000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
