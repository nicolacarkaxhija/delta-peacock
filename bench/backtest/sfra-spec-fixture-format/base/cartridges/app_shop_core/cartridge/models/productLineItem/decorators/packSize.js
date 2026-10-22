'use strict';

/** sizeName arrives as "EU;UK", for example "39;5.5". */
module.exports = function (line, product) {
    if (!product.custom.isGiftPack) return;
    line.size = product.custom.sizeName.split(';')[0];
    line.gender = product.custom.gender;
};
