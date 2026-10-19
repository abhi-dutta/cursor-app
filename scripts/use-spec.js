#!/usr/bin/env node
'use strict';

// Usage: npm run spec:use <name>
// Copies spec/examples/<name>.spec.yaml over spec/app.spec.yaml after validating it.
// Run with no argument to list the available examples.
const fs = require('node:fs');
const path = require('node:path');
const { loadSpecFile } = require('../backend/src/spec');

const root = path.resolve(__dirname, '..');
const examplesDir = path.join(root, 'spec', 'examples');
const target = path.join(root, 'spec', 'app.spec.yaml');

const available = fs.readdirSync(examplesDir).filter((f) => f.endsWith('.spec.yaml')).map((f) => f.replace('.spec.yaml', ''));
const name = process.argv[2];

if (!name || !available.includes(name)) {
  console.log(`Usage: npm run spec:use <name>\nAvailable: ${available.join(', ')}`);
  process.exit(name ? 1 : 0);
}

const source = path.join(examplesDir, `${name}.spec.yaml`);
loadSpecFile(source); // refuse to apply an invalid spec
fs.copyFileSync(source, target);
console.log(`spec/app.spec.yaml now uses "${name}". Use \`git diff spec/app.spec.yaml\` to see the change.`);
