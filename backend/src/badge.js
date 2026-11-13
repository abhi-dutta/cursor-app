'use strict';

/** One-line share label: tier, product name, and price. */
function badgeText(item) {
  const amount = item.price.toFixed(2);
  const parts = [item.name, `$${amount}`];
  // `tag` is optional in the spec/store; omit the tier prefix for untagged items.
  if (typeof item.tag === 'string' && item.tag) parts.unshift(item.tag.toUpperCase());
  return parts.join(' · ');
}

module.exports = { badgeText };
