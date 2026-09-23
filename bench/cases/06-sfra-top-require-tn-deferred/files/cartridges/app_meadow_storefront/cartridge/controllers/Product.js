'use strict';

/**
 * @module controllers/Product
 * @description Replaces the base Product-Show and Product-Variation routes.
 */

const URLUtils = require('dw/web/URLUtils');
const server = require('server');

const cache = require('*/cartridge/scripts/middleware/cache');
const consentTracking = require('*/cartridge/scripts/middleware/consentTracking');
const pageMetaData = require('*/cartridge/scripts/middleware/pageMetaData');
const breadcrumbs = require('*/cartridge/scripts/middleware/breadcrumbs');
const sizeAdvisor = require('*/cartridge/scripts/middleware/sizeAdvisor');
const recentlyViewed = require('*/cartridge/scripts/middleware/recentlyViewed');
const productHelper = require('*/cartridge/scripts/helpers/productHelpers');

server.extend(module.superModule);

/**
 * Product-Show: renders the product detail page, redirecting offline products
 * to the search page.
 */
server.replace(
    'Show',
    cache.applyPromotionSensitiveCache,
    consentTracking.consent,
    breadcrumbs.addProductTrail,
    sizeAdvisor.attachProfile,
    recentlyViewed.track,
    function (req, res, next) {
        const ProductMgr = require('dw/catalog/ProductMgr');
        const Site = require('dw/system/Site');
        const product = ProductMgr.getProduct(req.querystring.pid);
        const shippingEstimator = require('*/cartridge/scripts/shipping/shippingEstimator');

        const isOnline = productHelper.isSellable(product);
        const hideOffline = Site.getCurrent().getCustomPreferenceValue('hideOfflineProducts');

        if (!isOnline && hideOffline) {
            res.redirect(URLUtils.url('Search-Show', 'q', req.querystring.pid));

            return next();
        }

        const showProductPageHelperResult = productHelper.showProductPage(req.querystring, req.pageMetaData);

        if (!showProductPageHelperResult.product.online) {
            res.setStatusCode(404);
            res.render('error/notFound');

            return next();
        }

        const viewData = res.getViewData();

        viewData.product = showProductPageHelperResult.product;
        viewData.breadcrumbs = showProductPageHelperResult.breadcrumbs;
        viewData.canonicalUrl = showProductPageHelperResult.canonicalUrl;
        viewData.deliveryWindow = shippingEstimator.getDeliveryWindow(product, req.locale.id);

        res.setViewData(viewData);
        res.render(showProductPageHelperResult.template);

        return next();
    },
    pageMetaData.computedPageMetaData
);

/**
 * Product-Variation: returns the selected variant as JSON for swatch changes.
 */
server.replace(
    'Variation',
    function (req, res, next) {
        const ProductFactory = require('*/cartridge/scripts/factories/product');
        const renderTemplateHelper = require('*/cartridge/scripts/renderTemplateHelper');
        const params = req.querystring;
        const product = ProductFactory.get(params);

        const attributesHtml = renderTemplateHelper.getRenderedHtml(
            { product: product },
            'product/components/mainAttributes'
        );

        res.json({
            product: product,
            resources: productHelper.getResources(),
            attributesHtml: attributesHtml
        });

        return next();
    }
);

module.exports = server.exports();
