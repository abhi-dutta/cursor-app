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

test('a testimonials section is valid', () => {
  const { spec } = parseSpec(`
version: 1
app: { name: X }
sections:
  - id: testimonials
    type: testimonials
    columns: 3
    items:
      - { quote: "We shipped a UI change in 4 minutes.", name: Priya N., role: Platform Lead, rating: 5 }
`);
  assert.equal(spec.sections[0].items[0].name, 'Priya N.');
  assert.equal(spec.sections[0].items[0].rating, 5);
});

test('testimonials rejects a missing quote or name, a rating outside 1-5, and columns outside 1-4', () => {
  const section = (item, extra = '') => `
version: 1
app: { name: X }
sections:
  - id: t
    type: testimonials
    ${extra}
    items:
      - ${item}
`;
  const rejects = (yaml, pattern) => {
    assert.throws(() => parseSpec(yaml), (err) => {
      assert.ok(err instanceof SpecError);
      assert.match(err.errors.join('\n'), pattern);
      return true;
    });
  };
  rejects(section('{ name: Ana, rating: 5 }'), /quote is required/);
  rejects(section('{ quote: Hello, rating: 5 }'), /name is required/);
  rejects(section('{ quote: Hello, name: Ana, rating: 0 }'), /rating must be an integer from 1 to 5/);
  rejects(section('{ quote: Hello, name: Ana, rating: 6 }'), /rating must be an integer from 1 to 5/);
  rejects(section('{ quote: Hello, name: Ana, rating: 5 }', 'columns: 0'), /columns must be 1-4/);
  rejects(section('{ quote: Hello, name: Ana, rating: 5 }', 'columns: 5'), /columns must be 1-4/);
});

test('non-mapping sections are rejected cleanly', () => {
  assert.throws(() => parseSpec('version: 1\napp: { name: X }\ntheme: null\n'), SpecError);
});

test('SpecProvider (watch) picks up edits, keeps the last good spec on a bad edit, and recovers', () => {
  const os = require('node:os');
  const { SpecProvider } = require('../src/spec');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-test-'));
  const file = path.join(dir, 'app.spec.yaml');
  try {
    fs.writeFileSync(file, 'version: 1\napp:\n  name: First\n');
    const provider = new SpecProvider(file, { watch: true });
    assert.equal(provider.get().spec.app.name, 'First');

    fs.writeFileSync(file, 'version: 1\napp:\n  name: Second\n');
    assert.equal(provider.get().spec.app.name, 'Second');

    const originalError = console.error;
    console.error = () => {};
    try {
      fs.writeFileSync(file, 'version: 99\n');
      assert.equal(provider.get().spec.app.name, 'Second'); // last good
      assert.ok(provider.lastError);
    } finally {
      console.error = originalError;
    }

    fs.writeFileSync(file, 'version: 1\napp:\n  name: Second\n');
    assert.equal(provider.get().spec.app.name, 'Second');
    assert.equal(provider.lastError, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SpecProvider (no watch) never re-reads the file', () => {
  const os = require('node:os');
  const { SpecProvider } = require('../src/spec');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-test-'));
  const file = path.join(dir, 'app.spec.yaml');
  try {
    fs.writeFileSync(file, 'version: 1\napp:\n  name: First\n');
    const provider = new SpecProvider(file);
    fs.writeFileSync(file, 'version: 1\napp:\n  name: Changed\n');
    assert.equal(provider.get().spec.app.name, 'First');
    assert.throws(() => new SpecProvider(path.join(dir, 'missing.yaml')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
