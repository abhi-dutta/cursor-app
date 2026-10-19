'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseSpec, loadSpecFile, DEFAULT_SPEC_PATH, SpecError } = require('../src/spec');

const examplesDir = path.resolve(__dirname, '../../spec/examples');

test('the shipped spec is valid', () => {
  const { spec, hash } = loadSpecFile(DEFAULT_SPEC_PATH);
  assert.ok(spec.app.name);
  assert.match(hash, /^[0-9a-f]{8}$/);
});

test('every example spec is valid', () => {
  const files = fs.readdirSync(examplesDir).filter((f) => f.endsWith('.spec.yaml'));
  assert.ok(files.length > 0);
  for (const f of files) loadSpecFile(path.join(examplesDir, f));
});

test('defaults are applied to a minimal spec', () => {
  const { spec } = parseSpec('version: 1\napp:\n  name: Tiny\n');
  assert.equal(spec.theme.font, 'sans');
  assert.deepEqual(spec.sections, []);
});

test('same content gives the same hash, different content a different one', () => {
  const a = parseSpec('version: 1\napp:\n  name: A\n').hash;
  const b = parseSpec('version: 1\napp:\n  name: A\n').hash;
  const c = parseSpec('version: 1\napp:\n  name: C\n').hash;
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('invalid specs report every problem', () => {
  const bad = `
version: 1
app: { name: X }
theme: { primaryColor: red, font: comic }
hero: { cta: { label: Go, target: nowhere } }
sections:
  - { id: a, type: carousel }
  - { id: a, type: stats, metrics: [bogus] }
`;
  assert.throws(() => parseSpec(bad), (err) => {
    assert.ok(err instanceof SpecError);
    const text = err.errors.join('\n');
    assert.match(text, /theme.primaryColor/);
    assert.match(text, /theme.font/);
    assert.match(text, /sections\[0\].type/);
    assert.match(text, /duplicated/);
    assert.match(text, /bogus/);
    assert.match(text, /hero.cta.target/);
    return true;
  });
});

test('non-mapping sections are rejected cleanly', () => {
  assert.throws(() => parseSpec('version: 1\napp: { name: X }\ntheme: null\n'), SpecError);
});
