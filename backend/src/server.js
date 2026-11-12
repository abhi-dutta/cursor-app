'use strict';

const path = require('node:path');
const { createApp, readBuildInfo } = require('./app');
const { createIncidentReporter } = require('./incident');
const { SpecProvider, DEFAULT_SPEC_PATH } = require('./spec');
const { ItemStore } = require('./store');

const log = (entry) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);

const intFromEnv = (name, fallback) => {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const port = intFromEnv('PORT', 3000);
const specPath = process.env.SPEC_PATH || DEFAULT_SPEC_PATH;
const watch = process.env.SPEC_WATCH === 'true';
const frontendDir = process.env.SERVE_FRONTEND ? path.resolve(process.cwd(), process.env.SERVE_FRONTEND) : undefined;

let specProvider;
try {
  specProvider = new SpecProvider(specPath, { watch });
} catch (err) {
  log({ level: 'fatal', msg: 'cannot load spec', specPath, error: err.message });
  process.exit(1);
}

const store = new ItemStore(specProvider.get().spec.catalog.items);
const state = { ready: true };
const buildInfo = readBuildInfo();
const jira = {
  baseUrl: process.env.JIRA_BASE_URL || '',
  email: process.env.JIRA_EMAIL || '',
  apiToken: process.env.JIRA_API_TOKEN || '',
  projectKey: process.env.JIRA_PROJECT_KEY || '',
};
const incidentReporting = process.env.INCIDENT_REPORTING === 'true' && Object.values(jira).every(Boolean);
const reportIncident = createIncidentReporter({ ...jira, enabled: incidentReporting, log });
const app = createApp({
  specProvider,
  store,
  buildInfo,
  frontendDir,
  state,
  rateLimit: { max: intFromEnv('RATE_LIMIT_PER_MIN', 6000), writeMax: intFromEnv('WRITE_RATE_LIMIT_PER_MIN', 60) },
  log,
  reportIncident,
});

const server = app.listen(port, () => {
  log({
    level: 'info',
    msg: 'listening',
    port,
    version: buildInfo.version,
    commit: buildInfo.commit,
    environment: buildInfo.environment,
    specHash: specProvider.get().hash,
    watch,
    servingFrontend: Boolean(frontendDir),
    incidentReporting,
    });
});

// Outlive typical load balancer / proxy idle timeouts so keep-alive connections aren't reset mid-request.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

// Graceful shutdown: fail readiness, stop accepting connections and exit once
// in-flight requests finish. (The k8s preStop hook already waits for the endpoint
// to be removed from the Service before SIGTERM arrives.)
function shutdown(signal) {
  log({ level: 'info', msg: 'shutting down', signal });
  state.ready = false;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 25_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Crash loudly (and let Kubernetes restart us) rather than limp on in an unknown state.
process.on('uncaughtException', (err) => {
  log({ level: 'fatal', msg: 'uncaught exception', error: err.message, stack: err.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log({ level: 'fatal', msg: 'unhandled rejection', error: String(reason) });
  process.exit(1);
});
