'use strict';

var shippingHelpers = require('*/cartridge/scripts/checkout/shippingHelpers');

function OrderModel(container, options) {
    this.orderNo = container.orderNo;
    if (options.containerView === 'order') {
        this.billing = container.billingAddress;
    }
}

module.exports = OrderModel;
