'use strict';

var collections = require('*/cartridge/scripts/util/collections');
var ProductLineItemsModel = require('*/cartridge/models/productLineItems');

function buildItems(container, options) {
    var items = collections.map(container.productLineItems, function (item) { return item; });
    var view = options.containerView;
    var count = items.length;
    var hasGiftCards = container.giftCertificateLineItems.length > 0;
    var model = new ProductLineItemsModel(container.productLineItems, view);
    var total = count;
    return { model: model, total: total, hasGiftCards: hasGiftCards };
}

module.exports = { buildItems: buildItems };
