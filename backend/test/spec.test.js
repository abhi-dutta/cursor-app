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

const withTestimonials = (extra) => `
version: 1
app: { name: X }
sections:
  - id: quotes
    type: testimonials
${extra}
`;

test('testimonials: a valid section parses, optional fields may be omitted', () => {
  const { spec } = parseSpec(withTestimonials(`    columns: 2
    items:
      - { quote: "Great", name: Ann, role: SRE, avatar: "🙂", rating: 5 }
      - { quote: "Fine", name: Bob }`));
  assert.equal(spec.sections[0].items.length, 2);
});

test('testimonials: bad items and options are all reported', () => {
  assert.throws(() => parseSpec(withTestimonials(`    columns: 7
    items:
      - { name: NoQuote }
      - { quote: NoName }
      - { quote: Bad, name: Rating, rating: 6 }
      - { quote: Frac, name: Rating, rating: 2.5 }
      - { quote: Zero, name: Rating, rating: 0 }
      - just a string`)), (err) => {
    assert.ok(err instanceof SpecError);
    const text = err.errors.join('\n');
    assert.match(text, /items\[0\]\.quote is required/);
    assert.match(text, /items\[1\]\.name is required/);
    assert.match(text, /items\[2\]\.rating must be a whole number from 1 to 5/);
    assert.match(text, /items\[3\]\.rating/);
    assert.match(text, /items\[4\]\.rating/);
    assert.match(text, /items\[5\] must be a mapping/);
    assert.match(text, /columns must be 1-4/);
    return true;
  });
});

test('testimonials: an empty items list is rejected', () => {
  assert.throws(() => parseSpec(withTestimonials('    items: []')), /items must be a non-empty list/);
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
