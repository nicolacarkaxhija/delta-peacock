'use strict';

/** Sums product and gift certificate totals for any basket or order. */
function TotalsModel(container) {
    this.grandTotal = container.totalGrossPrice.value;
    this.giftCertificateTotal = container.giftCertificateTotalPrice.value;
}

module.exports = TotalsModel;
