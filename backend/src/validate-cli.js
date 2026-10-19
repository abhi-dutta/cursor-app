'use strict';

// Usage: node src/validate-cli.js [spec-file ...]
// Exits non-zero when a spec is invalid, so it can be used as a CI gate.
const path = require('node:path');
const { loadSpecFile, DEFAULT_SPEC_PATH } = require('./spec');

const files = process.argv.slice(2);
if (files.length === 0) files.push(DEFAULT_SPEC_PATH);

let failed = false;
for (const file of files) {
  try {
    const { hash } = loadSpecFile(path.resolve(file));
    console.log(`OK    ${file} (hash ${hash})`);
  } catch (err) {
    failed = true;
    console.error(`FAIL  ${file}\n${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
