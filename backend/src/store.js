'use strict';

/**
 * In-memory item store seeded from the spec. Deliberately simple: swap this
 * module for a real database client when the demo needs persistence.
 * Note: state is per-process, so with several replicas each pod has its own copy.
 */
class ItemStore {
  constructor(seed = []) {
    this.items = new Map();
    this.nextId = 1;
    for (const item of seed) this.#insert({ ...item });
  }

  #insert(item) {
    this.items.set(item.id, item);
    this.nextId = Math.max(this.nextId, item.id + 1);
    return item;
  }

  list() {
    return [...this.items.values()];
  }

  get(id) {
    return this.items.get(id);
  }

  create(data) {
    return this.#insert({ id: this.nextId, ...data });
  }

  update(id, data) {
    const existing = this.items.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...data, id };
    this.items.set(id, updated);
    return updated;
  }

  delete(id) {
    return this.items.delete(id);
  }

  get size() {
    return this.items.size;
  }
}

/** Validates a create/update payload. Returns { value } or { errors }. */
function validateItemInput(body, { partial = false } = {}) {
  const errors = [];
  const value = {};
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['body must be a JSON object'] };
  }

  const field = (name, check, message) => {
    if (body[name] === undefined) {
      if (!partial && name === 'name') errors.push('name is required');
      if (!partial && name === 'price') errors.push('price is required');
      return;
    }
    if (!check(body[name])) errors.push(message);
    else value[name] = typeof body[name] === 'string' ? body[name].trim() : body[name];
  };

  field('name', (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 80, 'name must be a non-empty string (max 80 chars)');
  field('description', (v) => typeof v === 'string' && v.length <= 300, 'description must be a string (max 300 chars)');
  field('price', (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0, 'price must be a number >= 0');
  field('emoji', (v) => typeof v === 'string' && v.length <= 8, 'emoji must be a short string');
  field('tag', (v) => typeof v === 'string' && v.length <= 20, 'tag must be a string (max 20 chars)');

  return errors.length ? { errors } : { value };
}

module.exports = { ItemStore, validateItemInput };
