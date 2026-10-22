'use strict';

/*
 * Spec-driven renderer.
 * Fetches /api/spec and renders it. To add a NEW kind of block:
 *   1. add a renderer to SECTION_RENDERERS below
 *   2. add the type to SECTION_TYPES in backend/src/spec.js (+ validation)
 *   3. document it in spec/README.md
 * All text goes through textContent (never innerHTML), so spec/API data can't inject markup.
 */

const POLL_MS = 4000;
const root = document.getElementById('app');

const state = { hash: null, spec: null, items: [], version: null, stats: null, frontend: null, backendUp: true };

// ---------- tiny DOM helper ---------------------------------------------------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.details ? body.details.join(', ') : body.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const money = (n) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n);

function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

// ---------- theme -------------------------------------------------------------
function applyTheme(spec) {
  const { theme, app } = spec;
  const style = document.documentElement.style;
  style.setProperty('--primary', theme.primaryColor);
  style.setProperty('--accent', theme.accentColor);
  style.setProperty('--bg', theme.background);
  style.setProperty('--surface', theme.surface);
  style.setProperty('--text', theme.textColor);
  style.setProperty('--radius', `${theme.radius}px`);
  document.documentElement.dataset.font = theme.font;
  document.documentElement.style.colorScheme = theme.mode;
  document.title = app.name;
}

// ---------- metrics for the "stats" section -----------------------------------
const METRIC_DEFS = {
  version: { label: 'Backend version', read: (s) => s.version && `${s.version.version}` },
  pod: { label: 'Serving pod', read: (s) => s.version && s.version.pod },
  environment: { label: 'Environment', read: (s) => s.version && s.version.environment },
  uptime: { label: 'Uptime', read: (s) => s.stats && formatUptime(s.stats.uptimeSeconds) },
  requests: { label: 'API requests', read: (s) => s.stats && String(s.stats.requests) },
  items: { label: 'Catalog items', read: (s) => s.stats && String(s.stats.items) },
};

function renderStatValue(metric) {
  const value = METRIC_DEFS[metric].read(state);
  return value || '–';
}

// ---------- section renderers --------------------------------------------------
const SECTION_RENDERERS = {
  features(section) {
    return h('div', { class: `grid cols-${section.columns || 3}` },
      section.items.map((it) =>
        h('div', { class: 'card feature' },
          it.icon && h('div', { class: 'icon', text: it.icon }),
          h('h3', { text: it.title }),
          it.description && h('p', { text: it.description }),
        )));
  },

  stats(section) {
    return h('div', { class: 'grid cols-3' },
      section.metrics.map((m) =>
        h('div', { class: 'card stat' },
          h('div', { class: 'label', text: METRIC_DEFS[m].label }),
          h('div', { class: 'value', 'data-metric': m, text: renderStatValue(m) }),
        )));
  },

  catalog(section) {
    const { catalog } = state.spec;
    const list = section.layout === 'list';
    const wrapper = h('div');
    if (state.items.length === 0) wrapper.append(h('p', { class: 'empty', text: 'No items yet.' }));
    else {
      wrapper.append(
        h('div', { class: `catalog ${list ? 'list' : 'grid'}` },
          state.items.map((item) => renderItem(item, section, catalog.allowEdit))),
      );
    }
    if (catalog.allowEdit) wrapper.append(renderAddForm());
    return wrapper;
  },

  text(section) {
    return h('p', { class: 'text-body', text: section.body || '' });
  },

  testimonials(section) {
    return h('div', { class: `grid cols-${section.columns || 3}` },
      section.items.map((it) =>
        h('figure', { class: 'card testimonial' },
          it.rating && h('div', { class: 'stars', role: 'img', 'aria-label': `${it.rating} out of 5 stars`, text: stars(it.rating) }),
          h('blockquote', { text: it.quote }),
          h('figcaption', {},
            h('span', { class: 'avatar', text: it.avatar || it.name.charAt(0).toUpperCase() }),
            h('span', { class: 'who' },
              h('strong', { text: it.name }),
              it.role && h('span', { text: it.role }))))));
  },
};

function stars(rating) {
  return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

function renderItem(item, section, editable) {
  const price = section.showPrice !== false && h('span', { class: 'price', text: money(item.price) });
  const del = editable && h('button', { class: 'btn small danger', onclick: () => removeItem(item.id) }, 'Delete');
  const title = h('h3', {}, item.name, item.tag && h('span', { class: 'tag', text: item.tag }));
  if (section.layout === 'list') {
    return h('div', { class: 'card item' },
      h('div', { class: 'emoji', text: item.emoji || '📦' }),
      h('div', { class: 'body' }, title, item.description && h('p', { text: item.description })),
      price, del);
  }
  return h('div', { class: 'card item' },
    h('div', { class: 'emoji', text: item.emoji || '📦' }),
    title,
    item.description && h('p', { text: item.description }),
    h('div', { class: 'row' }, price, del));
}

function renderAddForm() {
  const error = h('p', { class: 'error', hidden: true });
  const name = h('input', { placeholder: 'Name', required: true, maxlength: 80 });
  const price = h('input', { placeholder: 'Price', type: 'number', min: 0, step: '0.01', required: true });
  const form = h('form', { class: 'add-form' }, name, price, h('button', { class: 'btn', type: 'submit' }, 'Add item'), error);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.hidden = true;
    try {
      await api('/api/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.value, price: Number(price.value), emoji: '🆕' }),
      });
      await refreshItems();
      render();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  });
  return form;
}

async function removeItem(id) {
  await api(`/api/items/${id}`, { method: 'DELETE' }).catch(() => {});
  await refreshItems();
  render();
}

// ---------- page ---------------------------------------------------------------
function renderHeader(spec) {
  const links = spec.sections.filter((s) => s.title).map((s) => h('a', { href: `#${s.id}`, text: s.title }));
  return h('header', { class: 'site-header' },
    h('div', { class: 'container' },
      h('div', { class: 'brand' },
        h('span', { class: 'logo', text: spec.app.logo }),
        h('div', {}, spec.app.name, spec.app.tagline && h('span', { class: 'tagline', text: spec.app.tagline }))),
      h('nav', { class: 'nav' }, links)));
}

function renderHero(spec) {
  const { hero } = spec;
  if (!hero.title) return null;
  const text = h('div', {},
    hero.layout === 'centered' && hero.emoji && h('div', { class: 'emoji', text: hero.emoji }),
    h('h1', { text: hero.title }),
    hero.subtitle && h('p', { text: hero.subtitle }),
    hero.cta && h('a', { class: 'btn', href: `#${hero.cta.target}`, text: hero.cta.label }));
  return h('section', { class: `hero ${hero.layout}` },
    h('div', { class: 'container' }, text, hero.layout === 'split' && h('div', { class: 'art', text: hero.emoji || spec.app.logo })));
}

function renderSection(section) {
  const body = SECTION_RENDERERS[section.type](section);
  return h('section', { class: 'section', id: section.id },
    h('div', { class: 'container' },
      section.title && h('h2', { text: section.title }),
      section.subtitle && h('p', { class: 'subtitle', text: section.subtitle }),
      body));
}

function renderFooter(spec) {
  return h('footer', { class: 'site-footer' },
    h('div', { class: 'container' },
      h('div', { text: spec.footer.text }),
      spec.footer.showBuildInfo && h('div', { class: 'build-badge', id: 'build-badge' }, ...badgeParts())));
}

function badgeParts() {
  const { version, frontend, backendUp, hash } = state;
  const parts = [];
  if (frontend) parts.push(h('span', { text: `web ${frontend.version}` }));
  if (version) parts.push(h('span', { text: `api ${version.version}` }), h('span', { text: `pod ${version.pod}` }));
  parts.push(h('span', { text: `spec ${hash}` }));
  if (!backendUp) parts.push(h('span', { class: 'down', text: 'backend unreachable' }));
  return parts;
}

function render() {
  const { spec } = state;
  applyTheme(spec);
  root.replaceChildren(
    renderHeader(spec),
    spec.banner.enabled && spec.banner.text && h('div', { class: `banner ${spec.banner.tone}`, text: spec.banner.text }),
    h('main', {}, renderHero(spec), spec.sections.map(renderSection)),
    renderFooter(spec),
  );
}

// ---------- data ---------------------------------------------------------------
async function refreshItems() {
  state.items = await api('/api/items');
}

async function refreshLive() {
  const [version, stats] = await Promise.all([api('/api/version'), api('/api/stats')]);
  state.version = version;
  state.stats = stats;
}

/** Only touch the bits that change often, so inputs/scroll position survive. */
function updateLiveParts() {
  document.querySelectorAll('[data-metric]').forEach((el) => {
    el.textContent = renderStatValue(el.dataset.metric);
  });
  const badge = document.getElementById('build-badge');
  if (badge) badge.replaceChildren(...badgeParts());
}

let polling = false;

async function poll() {
  // Skip background tabs (saves API calls) and overlapping runs (slow network).
  if (document.hidden || polling) return;
  polling = true;
  try {
    const { hash, spec } = await api('/api/spec');
    await refreshLive();
    state.backendUp = true;
    if (hash !== state.hash) {
      state.hash = hash;
      state.spec = spec;
      await refreshItems();
      render();
    } else {
      updateLiveParts();
    }
  } catch (err) {
    if (err.status === 429) return; // rate limited: just try again on the next tick
    state.backendUp = false;
    if (state.spec) updateLiveParts();
    else root.replaceChildren(h('p', { class: 'fatal', text: `Cannot reach the backend (${err.message}). Retrying…` }));
  } finally {
    polling = false;
  }
}

async function start() {
  state.frontend = await fetch('/version.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (state.frontend && typeof state.frontend.version !== 'string') state.frontend = null;
  await poll();
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', poll); // refresh immediately when the tab comes back
}

start();
