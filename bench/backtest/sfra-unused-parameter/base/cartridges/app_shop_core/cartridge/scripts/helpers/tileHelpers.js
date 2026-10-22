'use strict';

function hasPurchasable(cards) {
    return cards.some(function (card) { return card.purchasable; });
}

module.exports = { hasPurchasable: hasPurchasable };
