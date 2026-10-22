'use strict';

var shippingHelpers = require('*/cartridge/scripts/checkout/shippingHelpers');

/** containerView is "orderList" for account history rows and "order" for the detail page. */
function OrderModel(container, options) {
    this.orderNo = container.orderNo;
    if (options.containerView === 'order') {
        this.billing = container.billingAddress;
    }
}

module.exports = OrderModel;
