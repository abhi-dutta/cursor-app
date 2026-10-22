'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');

const DEFAULT_SPEC_PATH = path.resolve(__dirname, '../../spec/app.spec.yaml');

const SECTION_TYPES = ['features', 'catalog', 'stats', 'text', 'testimonials'];
const METRICS = ['version', 'pod', 'environment', 'uptime', 'requests', 'items'];
const FONTS = ['sans', 'serif', 'mono', 'rounded'];
const TONES = ['info', 'success', 'warning'];

const DEFAULTS = {
  version: 1,
  app: { name: 'Demo App', tagline: '', logo: '🚀' },
  theme: {
    mode: 'light',
    primaryColor: '#0092e4',
    accentColor: '#ff7a1a',
    background: '#f4f7fb',
    surface: '#ffffff',
    textColor: '#10243a',
    font: 'sans',
    radius: 14,
  },
  banner: { enabled: false, tone: 'info', text: '' },
  hero: { layout: 'centered', title: '', subtitle: '', emoji: '', cta: null },
  sections: [],
  footer: { text: '', showBuildInfo: true },
  catalog: { allowEdit: false, items: [] },
};

class SpecError extends Error {
  constructor(errors) {
    super(`Invalid spec:\n - ${errors.join('\n - ')}`);
    this.name = 'SpecError';
    this.errors = errors;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Merge `override` onto `base`; arrays and scalars are replaced, objects merged. */
function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Returns a list of human readable problems (empty list == valid). */
function validateSpec(spec) {
  const errors = [];
  const str = (value, field) => {
    if (typeof value !== 'string') errors.push(`${field} must be a string`);
  };
  const oneOf = (value, allowed, field) => {
    if (!allowed.includes(value)) errors.push(`${field} must be one of: ${allowed.join(', ')}`);
  };

  if (!isPlainObject(spec)) return ['spec must be a YAML mapping'];

  for (const key of ['app', 'theme', 'banner', 'hero', 'footer', 'catalog']) {
    if (!isPlainObject(spec[key])) errors.push(`${key} must be a mapping`);
  }
  if (errors.length) return errors;

  if (spec.version !== 1) errors.push('version must be 1');

  if (!isPlainObject(spec.app) || !spec.app.name) errors.push('app.name is required');
  else {
    str(spec.app.name, 'app.name');
    str(spec.app.tagline, 'app.tagline');
    str(spec.app.logo, 'app.logo');
  }

  const t = spec.theme;
  oneOf(t.mode, ['light', 'dark'], 'theme.mode');
  oneOf(t.font, FONTS, 'theme.font');
  for (const key of ['primaryColor', 'accentColor', 'background', 'surface', 'textColor']) {
    if (typeof t[key] !== 'string' || !HEX.test(t[key])) errors.push(`theme.${key} must be a hex colour like "#0092e4"`);
  }
  if (typeof t.radius !== 'number' || t.radius < 0 || t.radius > 40) errors.push('theme.radius must be a number between 0 and 40');

  if (typeof spec.banner.enabled !== 'boolean') errors.push('banner.enabled must be true or false');
  oneOf(spec.banner.tone, TONES, 'banner.tone');
  str(spec.banner.text, 'banner.text');

  oneOf(spec.hero.layout, ['centered', 'split'], 'hero.layout');
  str(spec.hero.title, 'hero.title');
  str(spec.hero.subtitle, 'hero.subtitle');
  str(spec.hero.emoji, 'hero.emoji');
  if (spec.hero.cta !== null) {
    if (!isPlainObject(spec.hero.cta) || !spec.hero.cta.label || !spec.hero.cta.target) {
      errors.push('hero.cta needs both label and target');
    }
  }

  if (!Array.isArray(spec.sections)) errors.push('sections must be a list');
  else {
    const ids = new Set();
    spec.sections.forEach((s, i) => {
      const where = `sections[${i}]`;
      if (!isPlainObject(s)) return errors.push(`${where} must be a mapping`);
      if (!SECTION_TYPES.includes(s.type)) errors.push(`${where}.type must be one of: ${SECTION_TYPES.join(', ')}`);
      if (!s.id || typeof s.id !== 'string') errors.push(`${where}.id is required`);
      else if (ids.has(s.id)) errors.push(`${where}.id "${s.id}" is duplicated`);
      else ids.add(s.id);

      if (s.type === 'features') {
        if (!Array.isArray(s.items) || s.items.length === 0) errors.push(`${where}.items must be a non-empty list`);
        else s.items.forEach((it, j) => {
          if (!it || !it.title) errors.push(`${where}.items[${j}].title is required`);
        });
        if (s.columns !== undefined && ![1, 2, 3, 4].includes(s.columns)) errors.push(`${where}.columns must be 1-4`);
      }
      if (s.type === 'stats') {
        if (!Array.isArray(s.metrics) || s.metrics.length === 0) errors.push(`${where}.metrics must be a non-empty list`);
        else s.metrics.forEach((m) => {
          if (!METRICS.includes(m)) errors.push(`${where}.metrics contains "${m}" (allowed: ${METRICS.join(', ')})`);
        });
      }
      if (s.type === 'catalog' && s.layout !== undefined) oneOf(s.layout, ['grid', 'list'], `${where}.layout`);
      if (s.type === 'text') str(s.body, `${where}.body`);
      if (s.type === 'testimonials') {
        if (!Array.isArray(s.items) || s.items.length === 0) errors.push(`${where}.items must be a non-empty list`);
        else s.items.forEach((it, j) => {
          const at = `${where}.items[${j}]`;
          if (!isPlainObject(it)) return errors.push(`${at} must be a mapping`);
          if (typeof it.quote !== 'string' || !it.quote) errors.push(`${at}.quote is required`);
          if (typeof it.name !== 'string' || !it.name) errors.push(`${at}.name is required`);
          if (it.role !== undefined) str(it.role, `${at}.role`);
          if (it.avatar !== undefined) str(it.avatar, `${at}.avatar`);
          if (it.rating !== undefined && (!Number.isInteger(it.rating) || it.rating < 1 || it.rating > 5)) {
            errors.push(`${at}.rating must be a whole number from 1 to 5`);
          }
        });
        if (s.columns !== undefined && ![1, 2, 3, 4].includes(s.columns)) errors.push(`${where}.columns must be 1-4`);
      }
    });
    if (spec.hero.cta && !ids.has(spec.hero.cta.target)) {
      errors.push(`hero.cta.target "${spec.hero.cta.target}" does not match any section id`);
    }
  }

  str(spec.footer.text, 'footer.text');

  if (!isPlainObject(spec.catalog) || !Array.isArray(spec.catalog.items)) errors.push('catalog.items must be a list');
  else {
    const seen = new Set();
    spec.catalog.items.forEach((it, i) => {
      const where = `catalog.items[${i}]`;
      if (!it || typeof it.name !== 'string' || !it.name) errors.push(`${where}.name is required`);
      if (!it || !Number.isInteger(it.id) || it.id < 1) errors.push(`${where}.id must be a positive integer`);
      else if (seen.has(it.id)) errors.push(`${where}.id ${it.id} is duplicated`);
      else seen.add(it.id);
      if (!it || typeof it.price !== 'number' || it.price < 0) errors.push(`${where}.price must be a number >= 0`);
    });
  }

  return errors;
}

/** Parse + default + validate. Throws SpecError / YAML errors. */
function parseSpec(text) {
  const raw = YAML.parse(text);
  if (!isPlainObject(raw)) throw new SpecError(['spec must be a YAML mapping']);
  const spec = deepMerge(DEFAULTS, raw);
  const errors = validateSpec(spec);
  if (errors.length) throw new SpecError(errors);
  const hash = crypto.createHash('sha1').update(JSON.stringify(spec)).digest('hex').slice(0, 8);
  return { spec, hash };
}

function loadSpecFile(file = DEFAULT_SPEC_PATH) {
  return parseSpec(fs.readFileSync(file, 'utf8'));
}

/**
 * Holds the current spec. With `watch` it re-reads the file on each access and
 * re-parses only when the content changed (keeping the last good version if an
 * edit is invalid); without it the spec is loaded once at startup, which is what
 * we want in a container. The file is read exactly once per check (no separate
 * stat/exists call), so there is no check-then-use window.
 */
class SpecProvider {
  constructor(file = DEFAULT_SPEC_PATH, { watch = false } = {}) {
    this.file = file;
    this.watch = watch;
    this.lastError = null;
    this.text = fs.readFileSync(file, 'utf8');
    this.current = parseSpec(this.text); // throws on startup if invalid -> fail fast
  }

  get() {
    if (!this.watch) return this.current;
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      if (text !== this.text) {
        this.current = parseSpec(text);
        this.text = text;
      }
      this.lastError = null;
    } catch (err) {
      if (err.message !== this.lastError) {
        this.lastError = err.message;
        console.error(`[spec] keeping last valid spec: ${err.message}`);
      }
    }
    return this.current;
  }
}

module.exports = {
  DEFAULT_SPEC_PATH,
  DEFAULTS,
  SECTION_TYPES,
  METRICS,
  SpecError,
  SpecProvider,
  parseSpec,
  loadSpecFile,
  validateSpec,
};
