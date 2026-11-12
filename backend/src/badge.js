'use strict';

/** One-line share label: optional tier, product name, and price. */
function badgeText(item) {
  const amount = item.price.toFixed(2);
  // `tag` is optional; omit the tier segment for untagged items.
  const parts = typeof item.tag === 'string' && item.tag ? [item.tag.toUpperCase()] : [];
  parts.push(item.name, `$${amount}`);
  return parts.join(' · ');
}

module.exports = { badgeText };
