const { applyDiscount } = require("./pricing.js");

function totalFor(cart) {
  return cart.items.reduce((sum, item) => sum + applyDiscount(item.price), 0);
}

module.exports = { totalFor };
