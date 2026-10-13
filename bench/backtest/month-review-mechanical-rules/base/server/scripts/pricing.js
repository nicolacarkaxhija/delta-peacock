'use strict';

/**
 * The basket total in the basket's currency.
 * @param {Object} basket the basket to price
 * @returns {number} the total, 0 for an empty basket
 */
function total(basket) {
    return basket.lines.reduce(function (sum, line) {
        return sum + line.price * line.quantity;
    }, 0);
}

module.exports = { total: total };
