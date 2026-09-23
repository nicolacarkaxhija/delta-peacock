'use strict';

/**
 * Returns the markdown percentage of a style group, reusing the tile price when
 * the group is the product being shown.
 *
 * @param {Object} product - Product view model.
 * @param {dw.catalog.Product} styleGroup - Style group product.
 * @returns {number} Markdown percentage or 0.
 */
function getMarkdownPercent(product, styleGroup) {
    const PromotionMgr = require('dw/campaign/PromotionMgr');
    const priceFactory = require('*/cartridge/scripts/factories/price');
    const promotions = PromotionMgr.activeCustomerPromotions.getProductPromotions(styleGroup);
    let isCurrent = styleGroup.ID === product.id;

    if (isCurrent && product.price && product.price.sales) {
        return product.price.sales.markdownPercent || 0;
    }

    let price = priceFactory.getPrice(styleGroup, null, true, promotions, styleGroup.getOptionModel());

    return (price.sales && price.sales.markdownPercent) || 0;
}

/**
 * Returns the merchandising labels configured on a style group.
 *
 * @param {dw.catalog.Product} styleGroup - Style group product.
 * @returns {string[]} Labels.
 */
function getStyleGroupLabels(styleGroup) {
    if (!('merchLabels' in styleGroup.custom)) {
        return [];
    }

    return Array.from(styleGroup.custom.merchLabels);
}

/**
 * Checks whether a style group sits in a clearance category.
 *
 * @param {dw.catalog.Product} styleGroup - Style group product.
 * @returns {boolean} True when any online category is flagged clearance.
 */
function isClearance(styleGroup) {
    return styleGroup.getOnlineCategories().toArray().some(function (category) {
        const flag = category.custom.clearance;

        return flag === true;
    });
}

/**
 * Adds a comma separated badge list to every swatch of the finish attribute.
 *
 * @param {Object} product - Product view model.
 * @param {dw.catalog.ProductVariationModel} variationModel - Variation model.
 * @param {Object[]} variationAttributes - Variation attributes of the product model.
 */
function swatchBadges(product, variationModel, variationAttributes) {
    const Resource = require('dw/web/Resource');
    const collections = require('*/cartridge/scripts/util/collections');
    const Site = require('dw/system/Site');
    const enabledFeatures = Site.getCurrent().getCustomPreferenceValue('storefrontFeatureFlags');
    const badgesOn = enabledFeatures && enabledFeatures.includes('swatch_badges');

    if (!badgesOn) {
        return;
    }

    const styleGroups = variationModel.getMaster().getVariationGroups();
    const finishAttr = variationModel.getProductVariationAttribute('finish');

    if (!finishAttr) {
        return;
    }

    const finishValues = variationModel.getAllValues(finishAttr);
    const modelFinish = variationAttributes.find(attr => attr.id === 'finish');

    if (!modelFinish || !modelFinish.values) {
        return;
    }

    finishValues.toArray().forEach(finishValue => {
        const group = collections.find(styleGroups, function (candidate) {
            return candidate.variationModel.isSelectedAttributeValue(finishAttr, finishValue);
        });

        if (!group) {
            return;
        }

        let labels = getStyleGroupLabels(group);
        let swatch = modelFinish.values.find(function (value) {
            return value.id === finishValue.ID;
        });
        let markdown = getMarkdownPercent(product, group);

        if (markdown) {
            labels.push(Resource.msgf('badge.markdown', 'product', null, String(markdown)));
        }

        if (isClearance(group)) {
            labels.push('clearance');
        }

        swatch.badges = labels.join(',');
    });
}

module.exports = {
    swatchBadges: swatchBadges
};
