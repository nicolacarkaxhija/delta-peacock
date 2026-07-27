"use strict";

/**
 * Returns the discount percentage for a variation group.
 *
 * @param {Object} product - Product view model.
 * @param {dw.catalog.Product} variationGroup - Variation group product.
 * @returns {number} Discount percentage or 0.
 */
function getPriceDiscount(product, variationGroup) {
  const PromotionMgr = require("dw/campaign/PromotionMgr");
  const priceFactory = require("*/cartridge/scripts/factories/price");
  const promotions = PromotionMgr.activeCustomerPromotions.getProductPromotions(variationGroup);
  let isInPdp = variationGroup.ID === product.id;

  let priceDiscount = 0;

  if (isInPdp && product.price && product.price.sales) {
    priceDiscount = product.price.sales.discount;

    return priceDiscount;
  }

  let price = priceFactory.getPrice(
    variationGroup,
    null,
    true,
    promotions,
    variationGroup.getOptionModel(),
  );

  if (price.sales && price.sales.discount) {
    priceDiscount = price.sales.discount;
  }

  return priceDiscount || 0;
}

/**
 * Returns the badges configured for a variation group.
 *
 * @param {dw.catalog.Product} variationGroup - Variation group product.
 * @returns {string[]} Variation group badges.
 */
function getVariationGroupBadges(variationGroup) {
  if (!("badge" in variationGroup.custom)) {
    return [];
  }

  return Array.from(variationGroup.custom.badge);
}

/**
 * Checks whether a variation group belongs to a Last Chance category.
 *
 * @param {dw.catalog.Product} variationGroup - Variation group product.
 * @returns {boolean} True if the variation group is Last Chance.
 */
function isLastChanceVariationGroup(variationGroup) {
  return variationGroup
    .getOnlineCategories()
    .toArray()
    .some(function (category) {
      return category.custom.isLastChanceCategory === true;
    });
}

/**
 * Decorates color variation attributes with Optimizely badges.
 *
 * @param {Object} product - Product view model.
 * @param {dw.catalog.ProductVariationModel} variationModel - Product variation model.
 * @param {Object} variationAttributes - Variation attributes in the product model.
 */
function badges(product, variationModel, variationAttributes) {
  const Resource = require("dw/web/Resource");
  const collections = require("*/cartridge/scripts/util/collections");
  const sitePref = require("util/sitepref");
  const flagsMapping = sitePref.getValue("optimizelyFeatureExperimentationFlagsMapping");
  const optimizelyBadgesEnabled = flagsMapping && flagsMapping.includes("pdp_thumbnail_tag");

  if (!optimizelyBadgesEnabled) {
    return;
  }

  const variationGroups = variationModel.getMaster().getVariationGroups();
  const colorPVA = variationModel.getProductVariationAttribute("color");

  if (!colorPVA) {
    return;
  }

  const apiColorVariationValues = variationModel.getAllValues(colorPVA);
  const productModelColorAttr = variationAttributes.find((prop) => prop.id === "color");

  if (!productModelColorAttr || !productModelColorAttr.values) {
    return;
  }

  apiColorVariationValues.toArray().forEach((colorValue) => {
    let relatedVariationGroup = collections.find(variationGroups, function (variationGroupItem) {
      return variationGroupItem.variationModel.isSelectedAttributeValue(colorPVA, colorValue);
    });

    if (!relatedVariationGroup) {
      return;
    }

    let variationGroupBadges = getVariationGroupBadges(relatedVariationGroup);
    let isLastChance = isLastChanceVariationGroup(relatedVariationGroup);
    let colorVA = productModelColorAttr.values.find(function (val) {
      return val.id === colorValue.ID;
    });

    let priceDiscount = getPriceDiscount(product, relatedVariationGroup);

    if (priceDiscount) {
      let discountLabel = Resource.msgf(
        "price.discount.percentage",
        "product",
        null,
        String(priceDiscount),
      );

      variationGroupBadges.push(discountLabel);
    }

    if (isLastChance) {
      variationGroupBadges.push("sale", "final");
    }

    colorVA.optimizelyBadges = variationGroupBadges.join(",");
  });
}

module.exports = {
  badges,
};
