'use strict';

/** Adds totals, shipping and line items to an order model. */
function apply(model, container) {
    model.totals = { grandTotal: container.totalGrossPrice.value };
    model.itemCount = container.productLineItems.length;
}

module.exports = { apply: apply };
