'use strict';

/** One-line share label: optional tier, product name, and price. `tag` is optional on items. */
function badgeText(item) {
  const amount = item.price.toFixed(2);
  const parts = [item.name, `$${amount}`];
  if (typeof item.tag === 'string' && item.tag.length > 0) parts.unshift(item.tag.toUpperCase());
  return parts.join(' · ');
}

module.exports = { badgeText };
