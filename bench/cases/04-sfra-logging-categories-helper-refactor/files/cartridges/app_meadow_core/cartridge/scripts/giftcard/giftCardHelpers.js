'use strict';

/**
 * @module scripts/giftcard/giftCardHelpers
 * @description Balance, hold and redemption helpers for store gift cards.
 */

const Logger = require('dw/system/Logger');
const giftCardLog = Logger.getLogger('giftcard', 'giftcard.helpers');

const giftCardHelpers = {};

/**
 * @description Masks a gift card number for display, keeping the last four digits.
 * @param {string} cardNumber - full card number
 * @returns {string} masked card number
 */
giftCardHelpers.maskCardNumber = function (cardNumber) {
    if (!cardNumber || cardNumber.length < 4) {
        return '';
    }

    return '**** ' + cardNumber.slice(-4);
};

/**
 * @description Sums the payment instruments of one method on a basket or order.
 * @param {dw.order.LineItemCtnr} lineItemCtnr - basket or order
 * @param {string} methodId - payment method id
 * @returns {number} total amount paid with that method
 */
function sumInstruments(lineItemCtnr, methodId) {
    const instruments = lineItemCtnr.getPaymentInstruments(methodId).toArray();

    return instruments.reduce(function (sum, instrument) {
        return sum + instrument.paymentTransaction.amount.value;
    }, 0);
}

/**
 * @description Sums the gift card payment instruments of a basket or order.
 * @param {dw.order.LineItemCtnr} lineItemCtnr - basket or order
 * @returns {number} total amount paid by gift card
 */
giftCardHelpers.getGiftCardTotal = function (lineItemCtnr) {
    return sumInstruments(lineItemCtnr, 'GIFT_CARD');
};

/**
 * @description Sums the bonus credit payment instruments of a basket or order.
 * @param {dw.order.LineItemCtnr} lineItemCtnr - basket or order
 * @returns {number} total amount paid by bonus credit
 */
giftCardHelpers.getBonusCreditTotal = function (lineItemCtnr) {
    return sumInstruments(lineItemCtnr, 'BONUS_CREDIT');
};

/**
 * @description Builds before/used/after values for one balance bucket.
 * @param {number} balanceBefore - balance before the order
 * @param {number} used - amount used by the order
 * @returns {{before: number, used: number, after: number}} display values
 */
function buildBalanceView(balanceBefore, used) {
    const view = {
        before: balanceBefore,
        used: used
    };

    view.after = balanceBefore - used;

    return view;
}

/**
 * @description Tells whether the container is an order that has already been placed.
 * @param {dw.order.LineItemCtnr} lineItemCtnr - basket or order
 * @returns {boolean} true for a placed order
 */
function isPlacedOrder(lineItemCtnr) {
    const Order = require('dw/order/Order');

    return lineItemCtnr instanceof Order;
}

/**
 * @description Get display values for the card balance bucket.
 * @param {dw.order.LineItemCtnr} lineItemCtnr - basket or order
 * @returns {object|null} card balance view, or null when no card amount is used
 */
giftCardHelpers.getDisplayCardBalance = function (lineItemCtnr) {
    const GiftCardMgr = require('*/cartridge/scripts/giftcard/GiftCardMgr');
    const card = GiftCardMgr.getCardForBasket(lineItemCtnr);

    if (!card) {
        return null;
    }

    const used = giftCardHelpers.getGiftCardTotal(lineItemCtnr);

    if (used <= 0) {
        return null;
    }

    // a placed order has already reduced the balance
    const before = isPlacedOrder(lineItemCtnr) ? card.balance + used : card.balance;

    return buildBalanceView(before, used);
};

/**
 * @description Get display values for the bonus credit bucket.
 * @param {dw.order.LineItemCtnr} lineItemCtnr - basket or order
 * @returns {object|null} bonus credit view, or null when no credit is used
 */
giftCardHelpers.getDisplayBonusBalance = function (lineItemCtnr) {
    const GiftCardMgr = require('*/cartridge/scripts/giftcard/GiftCardMgr');
    const card = GiftCardMgr.getCardForBasket(lineItemCtnr);

    if (!card || !card.bonusEnabled) {
        return null;
    }

    const used = giftCardHelpers.getBonusCreditTotal(lineItemCtnr);

    if (used <= 0) {
        return null;
    }

    const before = isPlacedOrder(lineItemCtnr) ? card.bonusBalance + used : card.bonusBalance;

    return buildBalanceView(before, used);
};

/**
 * @description Get display values for both balance buckets.
 * @param {dw.order.LineItemCtnr} lineItemCtnr - basket or order
 * @returns {object|null} balance views, or null when neither bucket is used
 */
giftCardHelpers.getDisplayBalance = function (lineItemCtnr) {
    const card = giftCardHelpers.getDisplayCardBalance(lineItemCtnr);
    const bonus = giftCardHelpers.getDisplayBonusBalance(lineItemCtnr);

    if (!card && !bonus) {
        return null;
    }

    return {
        card: card,
        bonus: bonus
    };
};

/**
 * @description Tells whether this session already redeemed a card, logging the caller's trace.
 * @param {object} card - gift card instance, for the log message
 * @returns {boolean} true when the redemption must be skipped
 */
function isDuplicateRedemption(card) {
    // a second redemption in the same session would charge the card twice
    if (!session.privacy.giftCardRedeemed) {
        return false;
    }

    let trace = '';

    try {
        throw new Error('Gift card ' + card.ID + ' already redeemed in this session.');
    } catch (e) {
        trace = e.stack.replace(/\n/g, ' | ');
    }

    Logger.error('Skipping duplicate redemption. Trace: ' + trace);

    return true;
}

/**
 * @description Applies the card and bonus redemptions and sets the session guard.
 * @param {object} card - gift card instance
 * @param {number} cardAmount - card amount to redeem
 * @param {number} bonusAmount - bonus credit amount to redeem
 * @returns {void}
 */
function applyRedemption(card, cardAmount, bonusAmount) {
    if (cardAmount > 0) {
        card.redeem(cardAmount);
    }

    if (bonusAmount > 0) {
        card.redeemBonus(bonusAmount);
    }

    session.privacy.giftCardRedeemed = cardAmount > 0 || bonusAmount > 0;
}

/**
 * @description Redeems the card and bonus amounts of a placed order.
 * @param {dw.order.Order} order - placed order
 * @returns {void}
 * @throws {Error} when an order paid by gift card has no card
 */
function redeemBalance(order) {
    if (!order) {
        return;
    }

    const cardAmount = giftCardHelpers.getGiftCardTotal(order);
    const bonusAmount = giftCardHelpers.getBonusCreditTotal(order);

    if (cardAmount <= 0 && bonusAmount <= 0) {
        return;
    }

    const GiftCardMgr = require('*/cartridge/scripts/giftcard/GiftCardMgr');
    const card = GiftCardMgr.getCardForBasket(order);

    if (!card) {
        throw new Error('No gift card found for order ' + order.orderNo);
    }

    if (isDuplicateRedemption(card)) {
        return;
    }

    const Transaction = require('dw/system/Transaction');

    Transaction.wrap(function () {
        applyRedemption(card, cardAmount, bonusAmount);
    });
}

/**
 * @description Restores the gift card balance when an order is cancelled.
 * @param {dw.order.Order} order - cancelled order
 * @param {number} amount - amount to restore
 * @returns {void}
 */
function restoreBalance(order, amount) {
    if (!order || amount <= 0) {
        return;
    }

    const GiftCardMgr = require('*/cartridge/scripts/giftcard/GiftCardMgr');
    const card = GiftCardMgr.getCardForBasket(order);

    if (!card) {
        return;
    }

    const Transaction = require('dw/system/Transaction');

    Transaction.wrap(function () {
        card.restore(amount);
    });
}

giftCardHelpers.redeemBalance = redeemBalance;
giftCardHelpers.restoreBalance = restoreBalance;

/**
 * @description Parses the gift card block of an order import payload.
 * @param {string} payload - raw JSON payload
 * @returns {object|null} parsed gift card data, or null when unreadable
 */
giftCardHelpers.parseImportedCard = function (payload) {
    try {
        return JSON.parse(payload).giftCard || null;
    } catch (e) {
        Logger.error('Unreadable gift card payload: {0}', e.toString());

        return null;
    }
};

/**
 * @description Logs a balance check for audit purposes.
 * @param {string} cardNumber - full card number
 * @param {number} balance - balance returned by the provider
 * @returns {void}
 */
giftCardHelpers.auditBalanceCheck = function (cardNumber, balance) {
    giftCardLog.info('Balance check for {0}: {1}', giftCardHelpers.maskCardNumber(cardNumber), balance);
};

module.exports = giftCardHelpers;
