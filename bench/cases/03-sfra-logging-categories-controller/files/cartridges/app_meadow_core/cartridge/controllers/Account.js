'use strict';

/**
 * @module controllers/Account
 * @description Extends the base Account controller with rewards features.
 */

const server = require('server');

server.extend(module.superModule);

const userLoggedIn = require('*/cartridge/scripts/middleware/userLoggedIn');
const consentTracking = require('*/cartridge/scripts/middleware/consentTracking');
const rewardsMiddleware = require('*/cartridge/scripts/middleware/rewards');
const accountLog = require('dw/system/Logger').getLogger('account', 'account.rewards');

/**
 * Account-Show: adds the rewards opt-in flag to the dashboard view data.
 */
server.append(
    'Show',
    consentTracking.consent,
    rewardsMiddleware.addOptInFlag,
    function (req, res, next) {
        const viewData = res.getViewData();

        viewData.showRewardsTile = !!viewData.rewardsOptIn;
        res.setViewData(viewData);

        return next();
    }
);

/**
 * Account-RewardsOptIn: stores the customer's rewards opt-in choice.
 */
server.post(
    'RewardsOptIn',
    server.middleware.https,
    userLoggedIn.validateLoggedInAjax,
    function (req, res, next) {
        const Transaction = require('dw/system/Transaction');
        const profile = req.currentCustomer.raw.profile;
        const optIn = req.form.optIn === 'true';

        try {
            Transaction.wrap(function () {
                profile.custom.rewardsOptIn = optIn;
            });
            accountLog.info('Rewards opt-in set to {0} for customer {1}', optIn, profile.customerNo);
            res.json({ success: true, optIn: optIn });
        } catch (e) {
            accountLog.error('Rewards opt-in update failed: {0}', e.message);
            res.json({ success: false });
        }

        return next();
    }
);

/**
 * Account-RewardsPoll: polls the rewards backend for vouchers issued to the
 * logged-in customer and renders them as a tile.
 */
server.get(
    'RewardsPoll',
    server.middleware.https,
    userLoggedIn.validateLoggedIn,
    function (req, res, next) {
        const rewardsClient = require('*/cartridge/scripts/rewards/rewardsClient');
        const Logger = require('dw/system/Logger');

        try {
            const customer = req.currentCustomer.raw;

            if (!customer || !customer.profile) {
                res.json({ success: false });

                return next();
            }

            const memberId = customer.profile.custom.rewardsMemberId;

            if (!memberId) {
                res.json({ success: false });

                return next();
            }

            const startedAt = Date.now();

            Logger.info(
                'Rewards poll started for member {0}',
                memberId
            );
            const vouchers = rewardsClient.fetchVouchers(memberId);
            const seconds = ((Date.now() - startedAt) / 1000).toFixed(2);

            if (!vouchers || vouchers.length === 0) {
                Logger.info(
                    'Rewards poll for member {0} took {1}s, no vouchers yet',
                    memberId,
                    seconds
                );
                res.json({ success: true, vouchers: [] });

                return next();
            }

            Logger.info(
                'Rewards poll for member {0} took {1}s, vouchers: {2}',
                memberId,
                seconds,
                vouchers.length
            );

            const renderTemplateHelper = require('*/cartridge/scripts/renderTemplateHelper');

            res.json({
                success: true,
                vouchers: vouchers,
                html: renderTemplateHelper.getRenderedHtml({ vouchers: vouchers }, 'account/rewards/voucherTile')
            });
        } catch (e) {
            Logger.error(
                'Rewards poll failed: {0}',
                e.message
            );
            res.json({ success: false });
        }

        return next();
    }
);

module.exports = server.exports();
