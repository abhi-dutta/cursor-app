'use strict';

/** One-line share label: optional tier, product name, and price. `tag` is optional on items. */
function badgeText(item) {
  const amount = item.price.toFixed(2);
  const parts = [];
  if (typeof item.tag === 'string' && item.tag.trim()) parts.push(item.tag.trim().toUpperCase());
  parts.push(item.name, `$${amount}`);
  return parts.join(' · ');
}

module.exports = { badgeText };
