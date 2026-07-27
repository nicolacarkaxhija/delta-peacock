"use strict";

/**
 * @memberof app_storefront_widgets
 * @category app_storefront_widgets
 * @subcategory controllers
 * @module Product
 * @description Product controller uses for displaying product functionality on the storefront
 */

const URLUtils = require("dw/web/URLUtils");

const server = require("server");

const cache = require("*/cartridge/scripts/middleware/cache");
const productMiddleware = require("*/cartridge/scripts/middleware/product");
const addToCartOverlayMiddleware = require("*/cartridge/scripts/middleware/addToCartOverlay");
const widget = require("*/cartridge/scripts/middleware/widgets");
const fitPredictorMiddelware = require("*/cartridge/scripts/middleware/fitPredictor");
const pageMetaData = require("*/cartridge/scripts/middleware/pageMetaData");
const consentTracking = require("*/cartridge/scripts/middleware/consentTracking");
const breadcrumbs = require("*/cartridge/scripts/middleware/breadcrumbs");
const shopSection = require("*/cartridge/scripts/middleware/shopSection");
const subscription = require("*/cartridge/scripts/middleware/subscription");
const captchaMiddleware = require("*/cartridge/scripts/middleware/captcha");
const loyaltyMiddleware = require("*/cartridge/scripts/middleware/loyalty");

const ROUTE_COMPLETE = "route:Complete";
const NOT_FOUND_TEMPLATE = "error/notFound";

server.extend(module.superModule);

/**
 * @name renderNotFound
 * @function
 * @description Renders not found page
 */
function renderNotFound(req, res) {
  res.setStatusCode(404);
  res.render(NOT_FOUND_TEMPLATE);
}

/**
 * @name Product-Show
 * @function
 * @description Renders product details page.
 *
 * Replaces the base implementation to add:
 * - online/hideOnStorefront guard with early exit
 * - providedSecret access-gate
 * - master product redirect to first online variation group
 * - real-time inventory refresh (refreshInventory: true)
 * - inline GrabPay instalment data
 *
 * Middleware chain:
 * - *server.middleware.get* - GET only
 * - *cache.applyPromotionSensitiveCache* - promotion-sensitive cache
 * - *consentTracking.consent* - consent check
 * - *productMiddleware.availabilityURL* - remote availability URL
 * - *breadcrumbs.generateListSchema* - breadcrumb list schema
 * - *pageMetaData.computedPageMetaData* - page meta data
 * - *pageMetaData.canonicalUrl* - canonical URL
 * - *pageMetaData.hrefLang* - hreflang tags
 * - *widgets.addPrefsToViewData* - widget preferences
 * - *fitPredictorMiddelware.addProductContext* - FitPredictor data
 * - *shopSection.getShopSectionID* - shop section ID
 */
server.replace(
  "Show",
  server.middleware.get,
  cache.applyPromotionSensitiveCache,
  consentTracking.consent,
  /* eslint-disable consistent-return */
  function (req, res, next) {
    const ProductMgr = require("dw/catalog/ProductMgr");
    const productHelper = require("*/cartridge/scripts/helpers/productHelpers");
    const sitePref = require("util/sitepref");
    const product = ProductMgr.getProduct(req.querystring.pid);
    const deliveryUtil = require("*/cartridge/scripts/order/deliveryUtil");

    const isOnline = productHelper.isOnlineStorefrontProduct(product);
    const hideOnStorefrontPref = sitePref.getValue("hideOnStorefront");
    const hideOnStorefrontAttr = product && product.custom.hideOnStorefront;

    if (
      !isOnline ||
      (hideOnStorefrontPref && hideOnStorefrontAttr && hideOnStorefrontAttr.value === "yes")
    ) {
      renderNotFound(req, res);
      this.emit(ROUTE_COMPLETE, req, res);

      return;
    }

    const providedSecret = product && product.custom.providedSecret;

    if (providedSecret && req.querystring.access !== providedSecret) {
      renderNotFound(req, res);
      this.emit(ROUTE_COMPLETE, req, res);

      return;
    }

    if (product.master) {
      const firstOnlineVG = productHelper.getFirstOnlineVariationGroup(product);

      if (firstOnlineVG) {
        res.redirect(URLUtils.url("Product-Show", "pid", firstOnlineVG.ID));
      } else {
        renderNotFound(req, res);
      }

      this.emit(ROUTE_COMPLETE, req, res);

      return;
    }

    const showProductPageResult = productHelper.showProductPage(
      Object.assign({}, req.querystring, { refreshInventory: true }),
      req.pageMetaData,
    );

    const isGrabPayEnabledForCurrentCountry = productHelper.isGrabPayEnabledForCountry();

    if (isGrabPayEnabledForCurrentCountry) {
      showProductPageResult.grabPayAmountPerInstallment = productHelper.getBNPLInstallment(
        showProductPageResult.product,
      );
      showProductPageResult.isGrabPayEnabledForCurrentCountry = true;
    }

    /** *
     * ***** Custom Override Birkenstock *****
     *
     * This override used to show estimated delivery date
     */
    showProductPageResult.estimatedDeliveryDate = deliveryUtil.getEstimatedDeliveryDate();

    res.render(showProductPageResult.template, showProductPageResult);

    return next();
  },
  /* eslint-enable consistent-return */
  productMiddleware.availabilityURL,
  breadcrumbs.generateListSchema,
  pageMetaData.computedPageMetaData,
  pageMetaData.canonicalUrl,
  pageMetaData.hrefLang,
  widget.addPrefsToViewData(["addToCartMixin"]),
  fitPredictorMiddelware.addProductContext,
  shopSection.getShopSectionID,
);

/**
 * @name Product-Availability
 * @function
 * @description Renders availability related part of PDP page.
 *
 * Prepend:
 * - *server.middleware.include* - Includes middleware to allow only include requests
 */
server.get("Availability", server.middleware.include, function (req, res, next) {
  const productHelper = require("*/cartridge/scripts/helpers/productHelpers");
  const showProductAvailabilityHelperResult = productHelper.showProductAvailability(
    req.querystring,
  );
  const backInStockForm = server.forms.getForm("backInStock");
  const productIndex = req.querystring.productIndex;

  backInStockForm.clear();

  res.render(showProductAvailabilityHelperResult.template, {
    product: showProductAvailabilityHelperResult.product,
    addToCartUrl: showProductAvailabilityHelperResult.addToCartUrl,
    updateCartUrl: req.querystring.updateCartUrl,
    updateWishlistUrl: req.querystring.updateWishlistUrl,
    backInStockForm: backInStockForm,
    productIndex: productIndex,
    uuid: req.querystring.uuid,
    editModeQV: req.querystring.editModeQV,
    viewMode: req.querystring.viewMode,
  });

  next();
});

/**
 * @name Product-ShowWannaAR
 * @function
 * @description Renders Wanna AR IFrame contents
 */
server.get(
  "ShowWannaAR",
  server.middleware.get,
  server.middleware.https,
  cache.applyDefaultCache,
  function (req, res, next) {
    const isMobileView = req.querystring.isMobileView;
    const iframeUrl = req.querystring.iframeUrl;

    res.render("/product/wannaIFrame", {
      isMobileView: isMobileView,
      iframeUrl: iframeUrl,
    });
    next();
  },
);

/**
 * @name Product-GetIngredients
 * @function
 * @description Renders care essentials ingredients flyin
 */
server.get(
  "GetIngredients",
  server.middleware.get,
  server.middleware.https,
  cache.applyDefaultCache,
  function (req, res, next) {
    const ProductFactory = require("*/cartridge/scripts/factories/product");
    const product = ProductFactory.get({
      pid: req.querystring.pid,
      pview: "careEssentialsTileProduct",
    });

    res.render("components/product/ingredientsFlyin", {
      product: product,
    });
    next();
  },
);

/**
 * @name Product-ShowQuickView
 * @function
 * @description Renders product quick view component.
 *
 * Replaced because:
 * - SFRA core method was done due to inability SFCC to render remote includes
 * in templates, which are rendered not directly, but using `renderTemplateHelper.getRenderedHtml`
 * <br>This implementation, controller action `ShowQuickView` should output only rendered markup, but not json
 *
 * Prepend:
 * - *server.middleware.get* - Allows only GET requests
 * - *server.middleware.https* - Allows only HTTPS requests
 * - *cache.applyPromotionSensitiveCache* - Applies the default price promotion page cache.
 *
 * Append:
 * - *productMiddleware.availabilityURL* - Adds link to remote included availability block
 */
server.replace(
  "ShowQuickView",
  server.middleware.get,
  server.middleware.https,
  cache.applyPromotionSensitiveCache,
  function (req, res, next) {
    const productHelper = require("*/cartridge/scripts/helpers/productHelpers");
    const ProductFactory = require("*/cartridge/scripts/factories/product");
    const Resource = require("dw/web/Resource");

    const params = req.querystring;
    const product = ProductFactory.get(params);
    const addToCartUrl = URLUtils.url("Cart-AddProduct");
    const productOptionForm = server.forms.getForm("productOption");
    const template =
      product.productType === "set" ? "product/setQuickView.isml" : "product/quickView.isml";

    const context = {
      product: product,
      addToCartUrl: addToCartUrl,
      editModeQV: params.editModeQV === "true",
      resources: productHelper.getResources(),
      quickViewFullDetailMsg: Resource.msg("link.quickview.viewdetails", "product", null),
      closeButtonText: Resource.msg("link.quickview.close", "product", null),
      enterDialogMessage: Resource.msg("msg.enter.quickview", "product", null),
      productOptionForm: productOptionForm,
      template: template,
    };

    res.setViewData(context);

    this.on("route:BeforeComplete", function (req, res) {
      // eslint-disable-line no-shadow
      const viewData = res.getViewData();

      if (viewData.product.id) {
        res.render(viewData.template, viewData);
      } else {
        renderNotFound(req, res);
      }
    });

    next();
  },
  productMiddleware.availabilityURL,
  widget.addPrefsToViewData(["addToCartMixin"]),
);

/**
 * @name Product-Variation
 * @function
 * @description This endpoint is called when all the product variants are selected.
 *
 * Definitive implementation: builds the product with real-time inventory and
 * conditional image loading, renders price, attribute, promotion, option and
 * shipping HTML, and adds GrabPay and FitPredictor context.
 * Tabby and GTM payloads are appended by their respective integration
 * cartridges (int_custom_tabby, int_gtm).
 *
 * Prepend:
 * - *server.middleware.get* - Allows only GET requests
 * - *server.middleware.https* - Allows only HTTPS requests
 */
server.replace(
  "Variation",
  server.middleware.get,
  server.middleware.https,
  function (req, res, next) {
    const productHelper = require("*/cartridge/scripts/helpers/productHelpers");
    const priceHelper = require("*/cartridge/scripts/helpers/pricing");
    const ProductFactory = require("*/cartridge/scripts/factories/product");
    const renderTemplateHelper = require("*/cartridge/scripts/renderTemplateHelper");
    const shippingHelper = require("*/cartridge/scripts/checkout/shippingHelpers");

    const params = req.querystring;
    const productOptionForm = server.forms.getForm("productOption");
    const product = ProductFactory.get(
      Object.assign({}, params, {
        refreshInventory: true,
        skipImages: !params.isColorChange,
      }),
    );

    const context = {
      price: product.price,
      pricePerUnit: product.pricePerUnit,
      showStrikePriceAndBadge: product.showStrikePriceAndBadge,
      isPriceAtLowestLevel: false,
    };

    if (product.price) {
      if (
        product.price.sales &&
        product.price.sales.value !== undefined &&
        product.lowest30daysPriceValue === product.price.sales.value
      ) {
        context.isPriceAtLowestLevel = true;
      }

      product.price.html = priceHelper.renderHtml(priceHelper.getHtmlContext(context));
    }

    const attributeContext = { product: { attributes: product.attributes } };
    const attributeTemplate = "product/components/attributesPre";

    product.attributesHtml = renderTemplateHelper.getRenderedHtml(
      attributeContext,
      attributeTemplate,
    );

    const promotionsContext = { product: { promotions: product.promotions } };
    const promotionsTemplate = "product/components/promotions";

    product.promotionsHtml = renderTemplateHelper.getRenderedHtml(
      promotionsContext,
      promotionsTemplate,
    );

    const optionsContext = {
      product: { options: product.options },
      productOptionForm: productOptionForm,
    };
    const optionsTemplate = "product/components/options";

    product.optionsHtml = renderTemplateHelper.getRenderedHtml(optionsContext, optionsTemplate);

    if (product.shippingInfo) {
      product.shippingInfo.htmlMsg = shippingHelper.renderHtmlShippingMessage(product.shippingInfo);
    }

    if (product.deliveryInfo && product.deliveryInfo.shippingMethods.length) {
      product.deliveryInfo.htmlMsg = shippingHelper.renderHtmlDeliveryMessage(product.deliveryInfo);
    }

    const grabPayHtml = productHelper.renderGrabPayHtml(product);

    if (grabPayHtml) {
      product.grabPayInfoPdpHtml = grabPayHtml;
    }

    res.json({
      product: product,
      resources: productHelper.getResources(),
    });

    next();
  },
  fitPredictorMiddelware.addProductContext,
);

/**
 * @name Product-ShowBonusProducts
 * @function
 * @description Product-ShowBonusProducts : This endpoint is called when a product with bonus product is added to Cart
 *
 * Replaced because:
 * - added uuid, pliUUID, addToCartButtonMsg to viewData, changed rendering template, changed rendering approach
 *
 * Prepend:
 * - *server.middleware.get* - Allows only GET requests
 * - *server.middleware.https* - Allows only HTTPS requests
 */
server.replace(
  "ShowBonusProducts",
  server.middleware.get,
  server.middleware.https,
  function (req, res, next) {
    const BasketMgr = require("dw/order/BasketMgr");
    const collections = require("*/cartridge/scripts/util/collections");
    const bonusProductHelpers = require("*/cartridge/scripts/helpers/bonusProductHelpers");

    const duuid = req.querystring.DUUID;
    const pliUUID = req.querystring.pliuuid;

    const currentBasket = BasketMgr.getCurrentOrNewBasket();
    const bonusDiscountLineItems = currentBasket.getBonusDiscountLineItems();

    const bonusDiscountLineItem = collections.find(bonusDiscountLineItems, function (item) {
      return item.UUID === duuid;
    });

    const allBonusProducts = bonusProductHelpers.getBonusProducts(
      currentBasket,
      bonusDiscountLineItem,
      duuid,
    );

    const context = {
      duuid: bonusDiscountLineItem.UUID,
      pliUUID: pliUUID,
      products: allBonusProducts,
      maxPids: bonusDiscountLineItem.maxBonusItems,
      template: "product/chooseBonus.isml",
      totalSelected: 0,
      editMode: false,
    };

    res.setViewData(context);

    // TODO Create bonusProducts model
    this.on("route:BeforeComplete", function (req, res) {
      // eslint-disable-line no-shadow
      const viewData = res.getViewData();

      res.render(viewData.template, viewData);
    });

    next();
  },
  widget.addPrefsToViewData(["bonusProductMgr"]),
  addToCartOverlayMiddleware.appendModalData({ useCachedUrl: true, invalidate: false }),
);

/**
 * @name Product-AvailabilityReminderModal
 * @function
 * @description Renders availability reminder modal with captcha and email subscribe form.
 *
 * Append:
 * - *captchaMiddleware.addCaptchaToForms* - enables reCAPTCHA on the emailsubscribe form
 */
server.get(
  "AvailabilityReminderModal",
  function (req, res, next) {
    const ProductFactory = require("*/cartridge/scripts/factories/product");
    const siteHelpers = require("*/cartridge/scripts/helpers/siteHelpers");
    const subscriptionHelpers = require("*/cartridge/scripts/helpers/subscription");

    const profile = req.currentCustomer.profile;
    const showAvailabilityReminderNewsletterSubscription = siteHelpers.getLocalizedConfig(
      "newsletterSubscriptionConfig",
      "showAvailabilityReminderNewsletterSubscription",
      true,
    );
    const backInStockForm = server.forms.getForm("backInStock");
    const pid = req.querystring.pid;

    if (!pid) {
      res.setStatusCode(400);
      res.render(NOT_FOUND_TEMPLATE);

      return next();
    }

    const product = ProductFactory.get({
      pid: req.querystring.pid,
      pview: "availabilityReminder",
      skipWidthPreselect: true,
    });

    backInStockForm.clear();

    if (profile) {
      backInStockForm.email.value = profile.email;
    }

    res.render("product/availabilityReminderModal", {
      product: product,
      isQuickView: false,
      isBundle: product.productType === "bundle",
      backInStockForm: backInStockForm,
      emailSubscribeForm: server.forms.getForm("emailsubscribe"),
      showAvailabilityReminderNewsletterSubscription:
        showAvailabilityReminderNewsletterSubscription &&
        subscriptionHelpers.isSubscriptionAvailableForCountry(),
      is1774Page: product.is1774Product,
    });

    return next();
  },
  captchaMiddleware.addCaptchaToForms(["emailsubscribe", "backInStock"]),
);

/**
 * @name Product-SignInToBuyModal
 * @function
 * @description Renders sign in to buy modal with subscription, captcha and loyalty opt-in context.
 *
 * Prepend:
 * - *subscription.addSubscriptionData* - newsletter subscription config
 * - *captchaMiddleware.addCaptchaToForms* - enables reCAPTCHA on login and profile forms
 * - *loyaltyMiddleware.addLoyaltyOptInFlag* - Yotpo loyalty opt-in flag
 */
server.get(
  "SignInToBuyModal",
  subscription.addSubscriptionData,
  captchaMiddleware.addCaptchaToForms(["login", "profile"]),
  loyaltyMiddleware.addLoyaltyOptInFlag,
  function (req, res, next) {
    const gtmSignupLocation = req.querystring.gtmSignupLocation || "member_excl_flyin";

    res.render("product/signInToBuyModal", {
      loginForm: server.forms.getForm("login"),
      profileForm: server.forms.getForm("profile"),
      actionUrl: URLUtils.url("Account-Login", "reload", true),
      createAccountUrl: URLUtils.url("Account-SubmitRegistration", "reload", true),
      gtmSignupLocation: gtmSignupLocation,
      gtmSubscriptionSource: "member_excl_flyin",
    });

    return next();
  },
  widget.addPrefsToViewData(["loginForm", "registerForm"]),
);

module.exports = server.exports();
