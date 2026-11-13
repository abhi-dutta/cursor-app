'use strict';

/** One-line share label: tier, product name, and price. */
function badgeText(item) {
  const amount = item.price.toFixed(2);
  const label = `${item.name} · $${amount}`;
  // `tag` is optional on catalog items; omit the tier prefix when absent.
  return item.tag ? `${item.tag.toUpperCase()} · ${label}` : label;
}

module.exports = { badgeText };
