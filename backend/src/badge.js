'use strict';

/** One-line share label: tier, product name, and price. */
function badgeText(item) {
  const tier = item.tag.toUpperCase();
  const amount = item.price.toFixed(2);
  return `${tier} · ${item.name} · $${amount}`;
}

module.exports = { badgeText };
