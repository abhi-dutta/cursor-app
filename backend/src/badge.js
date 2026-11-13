'use strict';

/** One-line share label: optional tier (from `tag`), product name, and price. */
function badgeText(item) {
  const amount = item.price.toFixed(2);
  const label = `${item.name} · $${amount}`;
  // `tag` is optional on items, so only prefix the tier when one is set.
  return typeof item.tag === 'string' && item.tag.length > 0 ? `${item.tag.toUpperCase()} · ${label}` : label;
}

module.exports = { badgeText };
