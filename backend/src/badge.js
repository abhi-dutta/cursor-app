'use strict';

/** One-line share label: optional tier (from `tag`), product name, and price. */
function badgeText(item) {
  const amount = item.price.toFixed(2);
  const label = `${item.name} · $${amount}`;
  return typeof item.tag === 'string' && item.tag ? `${item.tag.toUpperCase()} · ${label}` : label;
}

module.exports = { badgeText };
