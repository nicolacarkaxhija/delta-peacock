'use strict';

var decorators = require('*/cartridge/models/order/decorators/index');

function WidgetsOrder(container, options) {
    this.orderNo = container.orderNo;
    decorators.apply(this, container);
}

module.exports = WidgetsOrder;
