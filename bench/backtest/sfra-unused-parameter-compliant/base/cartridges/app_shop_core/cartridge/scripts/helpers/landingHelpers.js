'use strict';

var tileHelpers = require('*/cartridge/scripts/helpers/tileHelpers');

function showTiles(cards) {
    return tileHelpers.hasPurchasable(cards);
}

module.exports = { showTiles: showTiles };
