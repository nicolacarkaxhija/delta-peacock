'use strict';

const logger = require('dw/system/Logger').getLogger('giftPack', 'checkout');

function pack(id) {
    return id;
}

module.exports = { pack: pack };
