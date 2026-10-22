'use strict';

module.exports = function (line, product) {
    line.isGiftPack = !!product.custom.isGiftPack;
};
