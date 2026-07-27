"use strict";

/**
 * @memberof app_custom_core
 * @category app_custom_core
 * @subcategory helpers
 * @module orderHelpers
 * @extends {app_storefront_widgets.module:orderHelpers}
 * @description Helper to work with orders functionality
 */

const Logger = require("dw/system/Logger");

const orderHelpers = module.superModule;

const FILTER_YEAR_PARAM = "orderYear";
const FILTER_MONTHS_PARAM = "orderTime";

/**
 * Creates an OrderModel instance from the current basket and request.
 *
 * @param {dw.order.Basket} currentBasket - The current basket object.
 * @param {object} req - The request object containing customer and session information.
 * @returns {OrderModel} The constructed OrderModel instance.
 */
function createOrderModelFromBasketAndRequest(currentBasket, req) {
  const Locale = require("dw/util/Locale");
  const COHelpers = require("*/cartridge/scripts/checkout/checkoutHelpers");
  const OrderModel = require("*/cartridge/models/order");
  const locale = Locale.getLocale(req.locale.id);

  let orderModel = new OrderModel(currentBasket, {
    customer: req.currentCustomer.raw,
    usingMultiShipping: req.session.privacyCache.get("usingMultiShipping"),
    shippable: COHelpers.ensureValidShipments(currentBasket),
    countryCode: locale && locale.country,
    containerView: {
      containerView: "basket",
      imagesView: ["minicart"],
    },
  });

  return orderModel;
}

/**
 * Determines the current Apple device type based on the HTTP User-Agent string.
 *
 * @returns {string} Returns 'DevL' for desktop, 'DevS' for iPhone (mobile), or 'DevM' for iPad (tablet).
 */
function findCurrentAppleDevice() {
  let deviceType = "DevL"; // desktop
  const iPhoneDevice = "iPhone";
  const iPadDevice = "iPad";
  const httpUserAgent = request.httpUserAgent;

  if (httpUserAgent.indexOf(iPhoneDevice) > 1) {
    deviceType = "DevS"; // mobile
  } else if (httpUserAgent.indexOf(iPadDevice) > 1) {
    deviceType = "DevM"; // tablet
  }

  return deviceType;
}

/**
 * @description Retrieves the main payment method ID for the given order
 * @param {dw.order.Order} order - The order object to retrieve the payment method from
 * @returns {string} The main payment method ID, or an empty string if none is found
 */
function getOrderMainPaymentMethodID(order) {
  const PaymentInstrument = require("dw/order/PaymentInstrument");
  const collections = require("*/cartridge/scripts/util/collections");

  let mainPaymentMethod = order.custom.Adyen_paymentMethod || "";

  if (!mainPaymentMethod) {
    collections.forEach(order.paymentInstruments, ({ paymentMethod }) => {
      if (paymentMethod !== PaymentInstrument.METHOD_GIFT_CERTIFICATE) {
        mainPaymentMethod = paymentMethod;
      }
    });
  }

  return mainPaymentMethod;
}

/**
 * @description Checks if the order was paid using a gift certificate
 * @param {dw.order.Order} order - The order object to retrieve the payment method from
 * @returns {boolean} True if the order was paid using a gift certificate, otherwise false
 */
function isPaidByGiftCertificate(order) {
  const PaymentInstrument = require("dw/order/PaymentInstrument");
  const collections = require("*/cartridge/scripts/util/collections");
  let hasGiftCertificate = false;

  if (order && order.paymentInstruments && order.paymentInstruments.length > 0) {
    collections.forEach(order.paymentInstruments, (pi) => {
      if (pi.paymentMethod === PaymentInstrument.METHOD_GIFT_CERTIFICATE) {
        hasGiftCertificate = true;
      }
    });
  }

  return hasGiftCertificate;
}

/**
 * Fills in custom attributes for the given order object.
 *
 * @param {dw.order.Order} order - The order object to update with custom attributes.
 */
function fillinOrderCustomAttributes(order) {
  const Transaction = require("dw/system/Transaction");
  const Site = require("dw/system/Site");
  const Calendar = require("dw/util/Calendar");
  const StringUtils = require("dw/util/StringUtils");
  const sitepref = require("util/sitepref");

  const currentSite = Site.getCurrent();
  const calendar = new Calendar(order.getCreationDate());

  calendar.setTimeZone(currentSite.timezone);

  const AdyenConfigs = require("*/cartridge/scripts/util/adyenConfigs");
  const merchantName = AdyenConfigs.getAdyenMerchantAccount();

  Transaction.wrap(() => {
    const orderProfile = order.getCustomer().getProfile();

    // the employee ID has to be stored since it cannot be retrieved from the customer profile
    // in case they unlink (e.g. customer deletes their profile)
    if (orderProfile && session.custom.hasEnoughAllowance) {
      order.custom.employeeNumber = orderProfile.custom.employeeNumber;
    }

    if (orderProfile) {
      order.custom.isEmployee = !!orderProfile.custom.isEmployee;
    }

    const paymentMethod = this.getOrderMainPaymentMethodID(order);
    const isCreditCard =
      !empty(order.paymentInstruments[0].custom.Adyen_Payment_Method_Variant) &&
      order.paymentInstruments[0].custom.Adyen_Payment_Method_Variant === "scheme";

    order.custom.customerIP = order.getRemoteHost();
    order.custom.orderCreationDate = StringUtils.formatCalendar(calendar, "yyyy-MM-dd HH:mm:ss");
    order.custom.SellingEntity = sitepref.getValue("SellingEntity");
    order.custom.Adyen_merchantId = merchantName;

    if (session.privacy.isExpressCheckout) {
      order.custom.paymentMethod = `${paymentMethod.toLowerCase()} express`;
    } else {
      order.custom.paymentMethod = `${isCreditCard ? "credit_card - " : ""}${paymentMethod.toLowerCase()}`;
    }

    if (order.custom.Adyen_paymentMethod === "applepay") {
      order.custom.createdByDevice = findCurrentAppleDevice();
    }

    let paymentMethods = [];

    paymentMethods.push(order.custom.paymentMethod);

    if (this.isPaidByGiftCertificate(order)) {
      paymentMethods.push("gift_certificate");
    }

    paymentMethods.push(order.custom.paymentMethod);

    if (paymentMethods.length > 0) {
      order.custom.appliedPaymentIDs = paymentMethods;
    }
  });
}

/**
 * @description Get applied employee discount by collecting and summing matching price adjustments.
 * @param {dw.order.LineItemCtnr} lineItemContainer - basket or order to inspect.
 * @param {Function} getEmployeePriceAdjustments - function that returns relevant employee price adjustments for a product line item.
 * @returns {number} summed absolute discount value, or 0 when no matching adjustments are found.
 */
function getAppliedEmployeeDiscountByGetter(lineItemContainer, getEmployeePriceAdjustments) {
  const productLineItems = lineItemContainer.getProductLineItems();

  if (empty(productLineItems)) {
    return 0;
  }

  const priceAdjustments = productLineItems
    .toArray()
    .reduce((acc, pli) => acc.concat(getEmployeePriceAdjustments(pli)), []);

  const appliedEmployeeDiscount = priceAdjustments.reduce(
    (acc, priceAdjustment) => acc - priceAdjustment.getPrice().value,
    0,
  );

  return appliedEmployeeDiscount;
}

/**
 * @description Get the amount of the regular employee discount applied to the order WHEN IT HAS BEEN PLACED.
 * @param {dw.order.LineItemCtnr} lineItemContainer - current user's basket/order.
 * @returns {number} - amount of the regular employee discount applied to the order, or 0 if not applied
 */
orderHelpers.getRegularAppliedEmployeeDiscount = function (lineItemContainer) {
  const productLineItemHelpers = require("*/cartridge/scripts/productLineItem/productLineItemHelpers");

  return getAppliedEmployeeDiscountByGetter(
    lineItemContainer,
    productLineItemHelpers.getEmployeeRegularPriceAdjustments,
  );
};

/**
 * @description Get the amount of the 1774 employee discount applied to the order WHEN IT HAS BEEN PLACED.
 * @param {dw.order.LineItemCtnr} lineItemContainer - current user's basket/order.
 * @returns {number} - amount of the 1774 employee discount applied to the order, or 0 if not applied
 */
orderHelpers.get1774AppliedEmployeeDiscount = function (lineItemContainer) {
  const productLineItemHelpers = require("*/cartridge/scripts/productLineItem/productLineItemHelpers");

  return getAppliedEmployeeDiscountByGetter(
    lineItemContainer,
    productLineItemHelpers.getEmployee1774PriceAdjustments,
  );
};

/**
 * @description Get the amount of all employee discounts (regular + 1774) applied to the order WHEN IT HAS BEEN PLACED.
 * @param {dw.order.LineItemCtnr} lineItemContainer - current user's basket/order.
 * @returns {number} - amount of all employee discounts applied to the order, or 0 if not applied
 */
orderHelpers.getAppliedEmployeeDiscount = function (lineItemContainer) {
  const productLineItemHelpers = require("*/cartridge/scripts/productLineItem/productLineItemHelpers");

  return getAppliedEmployeeDiscountByGetter(
    lineItemContainer,
    productLineItemHelpers.getEmployeePriceAdjustments,
  );
};

/**
 * @description Build allowance values for display before/after discount application.
 * Mirrors the cart helper allowance calculation logic.
 * @param {number} remainingAnnualDiscount - remaining allowance before order placement.
 * @param {number} appliedDiscount - discount amount currently applied in line-item container.
 * @param {number} requestedDiscount - discount amount requested by line-item container content.
 * @returns {{beforeOrder: number, drawdown: number, afterOrder?: number}}
 * formatted allowance values for UI consumption.
 */
function calculateAllowance(remainingAnnualDiscount, appliedDiscount, requestedDiscount) {
  const allowances = {
    beforeOrder: remainingAnnualDiscount,
  };

  if (appliedDiscount > 0) {
    allowances.drawdown = appliedDiscount;

    const allowanceAfterOrder = remainingAnnualDiscount - appliedDiscount;

    allowances.afterOrder = allowanceAfterOrder;

    return allowances;
  }

  allowances.drawdown = requestedDiscount;

  return allowances;
}

/**
 * @description Get regular employee allowance values for order or basket rendering.
 * @param {dw.order.LineItemCtnr} targetLineItemContainer - basket or order to evaluate.
 * @returns {object|null} regular allowance object, or null when no regular allowance data is applicable.
 */
orderHelpers.getDisplayRegularEmployeeAllowance = function (targetLineItemContainer) {
  const EmployeeMgr = require("*/cartridge/scripts/customObjects/employee/EmployeeMgr");
  const customerNo = targetLineItemContainer ? targetLineItemContainer.getCustomerNo() : "";
  const employee = EmployeeMgr.getEmployeeByCustomerNumber(customerNo);

  if (!employee || employee.unlimitedDiscount) {
    return null;
  }

  const regularAppliedDiscount =
    orderHelpers.getRegularAppliedEmployeeDiscount(targetLineItemContainer);

  if (regularAppliedDiscount <= 0) {
    return null;
  }

  const Order = require("dw/order/Order");
  const isOrder = targetLineItemContainer instanceof Order;
  const isConfirmedOrder =
    isOrder &&
    targetLineItemContainer.getConfirmationStatus().getValue() ===
      Order.CONFIRMATION_STATUS_CONFIRMED;

  const remainingRegularAllowance = employee.remainingAnnualDiscount;
  const regularAllowanceBeforeOrder = isConfirmedOrder
    ? remainingRegularAllowance + regularAppliedDiscount
    : remainingRegularAllowance;
  const regularAllowance = calculateAllowance(
    regularAllowanceBeforeOrder,
    regularAppliedDiscount,
    regularAppliedDiscount,
  );

  return {
    isPartner: employee.isExternal,
    isEmployeeDiscountApplied: regularAppliedDiscount > 0,
    allowanceRegular: regularAllowance,
    allowance1774: null,
  };
};

/**
 * @description Get 1774 employee allowance values for order or basket rendering.
 * @param {dw.order.LineItemCtnr} targetLineItemContainer - basket or order to evaluate.
 * @returns {object|null} 1774 allowance object, or null when no 1774 allowance data is applicable.
 */
orderHelpers.getDisplay1774EmployeeAllowance = function (targetLineItemContainer) {
  const siteHelpers = require("*/cartridge/scripts/helpers/siteHelpers");
  const EmployeeMgr = require("*/cartridge/scripts/customObjects/employee/EmployeeMgr");
  const customerNo = targetLineItemContainer ? targetLineItemContainer.getCustomerNo() : "";
  const employee = EmployeeMgr.getEmployeeByCustomerNumber(customerNo);

  if (!employee) {
    return null;
  }

  const currentCountry = siteHelpers.getCurrentShopCountryCode();

  if (currentCountry !== employee.countryCode) {
    return null;
  }

  const employee1774AppliedDiscount =
    orderHelpers.get1774AppliedEmployeeDiscount(targetLineItemContainer);

  const Order = require("dw/order/Order");
  const isOrder = targetLineItemContainer instanceof Order;
  const isConfirmedOrder =
    isOrder &&
    targetLineItemContainer.getConfirmationStatus().getValue() ===
      Order.CONFIRMATION_STATUS_CONFIRMED;

  const remaining1774Allowance = employee.remaining1774AnnualDiscount;

  let employee1774Allowance = null;

  if (employee1774AppliedDiscount > 0) {
    const allowance1774BeforeOrder = isConfirmedOrder
      ? remaining1774Allowance + employee1774AppliedDiscount
      : remaining1774Allowance;

    employee1774Allowance = calculateAllowance(
      allowance1774BeforeOrder,
      employee1774AppliedDiscount,
      employee1774AppliedDiscount,
    );
  }

  if (!employee1774Allowance) {
    return null;
  }

  return {
    isPartner: employee.isExternal,
    isEmployeeDiscountApplied: employee1774AppliedDiscount > 0,
    allowanceRegular: null,
    allowance1774: employee1774Allowance,
  };
};

/**
 * @description Get regular and 1774 employee allowance values for order or basket rendering.
 * @param {dw.order.LineItemCtnr} targetLineItemContainer - basket or order to evaluate.
 * @returns {object|null} allowance object with regular and/or 1774 buckets, or null when no employee allowance data is applicable.
 */
orderHelpers.getDisplayEmployeeAllowance = function (targetLineItemContainer) {
  const regularAllowances =
    orderHelpers.getDisplayRegularEmployeeAllowance(targetLineItemContainer);
  const allowances1774 = orderHelpers.getDisplay1774EmployeeAllowance(targetLineItemContainer);

  if (!regularAllowances && !allowances1774) {
    return null;
  }

  return {
    isPartner: regularAllowances ? regularAllowances.isPartner : allowances1774.isPartner,
    isEmployeeDiscountApplied: !!(
      (regularAllowances && regularAllowances.isEmployeeDiscountApplied) ||
      (allowances1774 && allowances1774.isEmployeeDiscountApplied)
    ),
    allowanceRegular: regularAllowances ? regularAllowances.allowanceRegular : null,
    allowance1774: allowances1774 ? allowances1774.allowance1774 : null,
  };
};

/**
 * @description Determine whether allowance increase should be skipped to prevent double charging.
 * @param {object} employee - employee instance for logging context.
 * @returns {boolean} true when increase should be skipped, false otherwise.
 */
function shouldSkipEmployeeAllowanceIncrease(employee) {
  // skip if allowance usage already increased: double charging can happen in case caller runs this method more than once for the same order
  // the flag is reset at the beginning of checkout process
  if (!session.privacy.employeeAllowanceIncreased) {
    return false;
  }

  let errorStack = "";

  // error thrown on purpose to get the stack trace of the caller function execution to be logged,
  // to investigate why double charging happens
  try {
    throw new Error(
      `Allowance usage of employee ${employee.ID} already increased for this checkout session.`,
    );
  } catch (e) {
    // replace newlines with a separator to avoid lines after the first one to be cut out from the log viewer
    errorStack = e.stack.replace(/\n/g, " | ");
  }

  Logger.error(`Skipping to prevent double increase. Stack trace: ${errorStack}`);

  return true;
}

/**
 * @description Apply regular and 1774 allowance usage increases and set session guard flag.
 * @param {object} employee - employee instance to update.
 * @param {number} regularDiscountAmount - regular discount amount to add to usage.
 * @param {number} employee1774DiscountAmount - 1774 discount amount to add to usage.
 * @returns {void}
 */
function applyEmployeeDiscountUsageIncrease(
  employee,
  regularDiscountAmount,
  employee1774DiscountAmount,
) {
  if (regularDiscountAmount > 0) {
    employee.increaseAnnualRegularDiscountUsage(regularDiscountAmount);
  }

  if (employee1774DiscountAmount > 0) {
    employee.increaseAnnual1774DiscountUsage(employee1774DiscountAmount);
  }

  // no usage increase takes place on employees with unlimited allowance
  // for them the flag remains off to prevent the above logging
  session.privacy.employeeAllowanceIncreased =
    regularDiscountAmount > 0 && !employee.unlimitedDiscount;
}

/**
 * @description Increase employee allowance usage from discounts applied on an order.
 * @param {dw.order.Order} order - order to evaluate.
 * @returns {void}
 * @throws {Error} if an employee cannot be found for a discounted order.
 */
function increaseEmployeeDiscountUsage(order) {
  if (!order) {
    return;
  }

  const regularDiscountAmount = orderHelpers.getRegularAppliedEmployeeDiscount(order);
  const employee1774DiscountAmount = orderHelpers.get1774AppliedEmployeeDiscount(order);
  const hasDiscountToIncrease = regularDiscountAmount > 0 || employee1774DiscountAmount > 0;

  if (!hasDiscountToIncrease) {
    return;
  }

  const customerNo = order.getCustomerNo();
  const EmployeeMgr = require("*/cartridge/scripts/customObjects/employee/EmployeeMgr");
  const employee = EmployeeMgr.getEmployeeByCustomerNumber(customerNo);

  if (!employee) {
    throw new Error(
      `Employee with customer number ${customerNo} not found when trying to increase their discount usage`,
    );
  }

  if (shouldSkipEmployeeAllowanceIncrease(employee)) {
    return;
  }

  const Transaction = require("dw/system/Transaction");

  Transaction.wrap(() =>
    applyEmployeeDiscountUsageIncrease(employee, regularDiscountAmount, employee1774DiscountAmount),
  );
}

/**
 * @description Decrease the employee's regular discount usage based on the order's applied employee discount, if any.
 * If the order was placed before the employee's allowance reset, the allowance can't be recaptured.
 * @param {dw.order.Order} order - order instance
 * @param {number} amount - amount to decrease the usage by
 * @throws {Error} if employee.decreaseAnnualRegularDiscountUsage() fails
 * @returns {void}
 */
function decreaseRegularEmployeeDiscountUsage(order, amount) {
  if (!order || amount <= 0) {
    return;
  }

  const EmployeeMgr = require("*/cartridge/scripts/customObjects/employee/EmployeeMgr");
  const employee = EmployeeMgr.getEmployeeByCustomerNumber(order.getCustomerNo());

  if (!employee) {
    return;
  }

  if (order.getCreationDate() < employee.lastAllowanceReset) {
    // employee allowance can't be recaptured as the order was placed before the allowance reset
    return;
  }

  const Transaction = require("dw/system/Transaction");

  Transaction.wrap(() => {
    employee.decreaseAnnualRegularDiscountUsage(amount);
  });
}

/**
 * @description Decrease the employee's 1774 discount usage based on the order's applied employee discount, if any.
 * If the order was placed before the employee's allowance reset, the allowance can't be recaptured.
 * @param {dw.order.Order} order - order instance
 * @param {number} amount - amount to decrease the usage by
 * @throws {Error} if employee.decreaseAnnual1774DiscountUsage() fails
 * @returns {void}
 */
function decrease1774EmployeeDiscountUsage(order, amount) {
  if (!order || amount <= 0) {
    return;
  }

  const EmployeeMgr = require("*/cartridge/scripts/customObjects/employee/EmployeeMgr");
  const employee = EmployeeMgr.getEmployeeByCustomerNumber(order.getCustomerNo());

  if (!employee) {
    return;
  }

  if (order.getCreationDate() < employee.lastAllowanceReset) {
    // employee allowance can't be recaptured as the order was placed before the allowance reset
    return;
  }

  const Transaction = require("dw/system/Transaction");

  Transaction.wrap(() => {
    employee.decreaseAnnual1774DiscountUsage(amount);
  });
}

/**
 * @description Maps offline order status code to order status string
 * @param {number} status - offline order status code
 * @returns {string} order status
 */
function getOfflineOrderStatusParsed(status) {
  const statusMapping = {
    10: "storepurchased",
    11: "returned",
  };

  return statusMapping[status];
}

/**
 * @description Retrieves the image model for a product line item in an offline order.
 * @param {dw.catalog.Product} product - The product associated with the line item.
 * @param {string} imageKey - The image type key (e.g., 'small', 'medium').
 * @returns {object|null} The image object if found, otherwise null.
 */
function getLineItemImage(product, imageKey) {
  const ImageModel = require("*/cartridge/models/product/productImages");
  let imageModel = new ImageModel(product, {
    types: [imageKey],
    quantity: "single",
  });

  let images = imageModel && imageModel[imageKey];

  return images && images.length ? images[0] : null;
}

/**
 * @description Retrieves the product number for a product in an offline order.
 * @param {dw.catalog.Product} product - The product associated with the line item.
 * @param {object} ProductFactory - The product factory for creating product models.
 * @returns {string|null} The product number if found, otherwise null.
 */
function getProductNumber(product, ProductFactory) {
  if (!product) {
    return null;
  }

  let productModel = ProductFactory.get({ pid: product.ID });

  return productModel && productModel.productNumber ? productModel.productNumber : null;
}

/**
 * @description Generates the product detail page URL for a given product.
 * @param {dw.catalog.Product} product - The product for which to generate the URL.
 * @returns {string|null} The product detail page URL if the product exists, otherwise null.
 */
function getPdpUrl(product) {
  if (!product) {
    return null;
  }

  const URLUtils = require("dw/web/URLUtils");

  return URLUtils.url("Product-Show", "pid", product.ID).toString();
}

/**
 * @description Clones a line item object.
 * @param {object} lineItem - The line item object to clone.
 * @returns {object} The cloned line item object.
 */
function cloneLineItem(lineItem) {
  let copy = {};

  for (let prop in lineItem) {
    if (Object.prototype.hasOwnProperty.call(lineItem, prop)) {
      copy[prop] = lineItem[prop];
    }
  }

  return copy;
}

/**
 * @description Retrieves detailed product information for line items in an offline order.
 * @param {Array} lineItems - Array of line item objects in the offline order.
 * @returns {object} An object containing enriched line items and their images.
 */
function getOfflineOrderProductDetails(lineItems) {
  const ProductMgr = require("dw/catalog/ProductMgr");
  const ProductFactory = require("*/cartridge/scripts/factories/product");
  const imageKey = require("util/pref").get("product.img.viewtype.orderlistitem", "small");

  let result = {
    lineItems: [],
    orderItemsImages: [],
  };

  for (let i = 0; i < lineItems.length; i++) {
    let lineItem = lineItems[i];
    let product = ProductMgr.getProduct(lineItem.id);
    let enrichedLineItem = this.cloneLineItem(lineItem);

    let image = this.getLineItemImage(product, imageKey);

    if (image) {
      enrichedLineItem.image = image;
      result.orderItemsImages.push(image);
    }

    let productNumber = this.getProductNumber(product, ProductFactory);

    if (productNumber) {
      enrichedLineItem.productNumber = productNumber;
    }

    enrichedLineItem.statusParsed = this.getOfflineOrderStatusParsed(enrichedLineItem.status);
    enrichedLineItem.subtotal = enrichedLineItem.rrp * enrichedLineItem.qty;
    enrichedLineItem.link = this.getPdpUrl(product);

    result.lineItems.push(enrichedLineItem);
  }

  return result;
}

/**
 * @description Retrieves store information for an offline order.
 * @param {string} storeId - The ID of the store.
 * @returns {object|null} An object containing store information, or null if the store is not found.
 */
function getOfflineOrderStoreInfo(storeId) {
  const StoreMgr = require("dw/catalog/StoreMgr");

  let store = StoreMgr.getStore(storeId);

  if (!store) {
    return null;
  }

  const Locale = require("dw/util/Locale");
  const currentLocale = Locale.getLocale(request.locale);

  return {
    name: store.getName(),
    stateCode: store.getStateCode(),
    postalCode: store.getPostalCode(),
    address1: store.getAddress1(),
    address2: store.getAddress2(),
    city: store.getCity(),
    phone: store.getPhone(),
    country: currentLocale && currentLocale.getDisplayCountry(),
  };
}

/**
 * @description Parses offline order JSON and returns an offline order object
 * @param {string} offlineOrderJSON - JSON string of the offline order
 * @param {string} customerEmail - Customer email
 * @returns {object|null} Offline order object or null if parsing fails
 */
function getOfflineOrderObjectFromJSON(offlineOrderJSON, customerEmail) {
  if (!offlineOrderJSON || !customerEmail) {
    return null;
  }

  try {
    let currentOfflineOrder = JSON.parse(offlineOrderJSON);
    let ooSaleDate = currentOfflineOrder.s_d;
    let ooSaleTime = currentOfflineOrder.s_t;
    let offlineOrderDate = new Date(
      ooSaleDate.substr(0, 4),
      parseInt(ooSaleDate.substr(4, 2), 10) - 1,
      ooSaleDate.substr(6, 2),
      ooSaleTime.substr(0, 2),
      ooSaleTime.substr(2, 2),
      ooSaleTime.substr(4, 2),
      2,
    );
    let productsInfo = this.getOfflineOrderProductDetails(currentOfflineOrder.items);

    currentOfflineOrder.orderDateTime = offlineOrderDate;
    currentOfflineOrder.orderDateTimeString = offlineOrderDate.toString();
    currentOfflineOrder.isOffline = true;
    currentOfflineOrder.statusParsed = this.getOfflineOrderStatusParsed(currentOfflineOrder.status);
    currentOfflineOrder.orderItemsImages = productsInfo.orderItemsImages;
    currentOfflineOrder.items = productsInfo.lineItems;
    currentOfflineOrder.customerEmail = customerEmail;
    currentOfflineOrder.storeInfo = this.getOfflineOrderStoreInfo(currentOfflineOrder.store);

    return currentOfflineOrder;
  } catch (e) {
    Logger.error("Error while parsing offline order: {0}", e.toString());
  }

  return null;
}

/**
 * @description Merges offline orders stored in customer profile into the SFCC orders array
 * @param {Array} orders - array of SFCC orders
 * @param {Array} offlineOrders - array of offline orders
 * @param {string} email - customer email
 * @returns {Array} Merged array of orders
 */
function mergeOfflineOrders(orders, offlineOrders, email) {
  if (!offlineOrders || offlineOrders.length === 0) {
    return orders;
  }

  for (let i = 0; i < offlineOrders.length; i++) {
    let currentOfflineOrder = this.getOfflineOrderObjectFromJSON(offlineOrders[i], email);

    if (!currentOfflineOrder) {
      continue;
    }

    orders.push(currentOfflineOrder);
  }

  orders.sort(function (a, b) {
    let dateA = "orderDateTime" in a ? a.orderDateTime : a.creationDate;
    let dateB = "orderDateTime" in b ? b.orderDateTime : b.creationDate;

    if (dateA > dateB) {
      return -1;
    }

    if (dateA < dateB) {
      return 1;
    }

    return 0;
  });

  return orders;
}

/**
 * @description Returns a list of filtered orders and possible orders years for filter
 * > Year options are being created here for performance purposes
 * @param {Array} customerOrders - Array of customer orders
 * @param {object} querystring - Querystring properties
 * @returns {object} Object with filtered orders and possible years for filter
 */
function processFiltering(customerOrders, querystring) {
  const ArrayList = require("dw/util/ArrayList");
  const Site = require("dw/system/Site");
  const Calendar = require("dw/util/Calendar");

  const yearFilter = querystring[FILTER_YEAR_PARAM];
  const monthFilter = querystring[FILTER_MONTHS_PARAM];

  let yearFilterValues = [];
  let orders = new ArrayList();
  let timeAgoFilter;

  if (!yearFilter) {
    const timeAgoCalendar = Site.getCalendar();

    timeAgoCalendar.add(
      Calendar.MONTH,
      monthFilter ? -monthFilter : -(new Date().getMonth() + 1) * 12,
    );

    timeAgoFilter = timeAgoCalendar.getTime();
  }

  for (let i = 0; i < customerOrders.length; i++) {
    let customerOrder = customerOrders[i];
    let orderCreationDate =
      "orderDateTime" in customerOrder
        ? customerOrder.orderDateTime
        : customerOrder.getCreationDate();
    let orderYear = orderCreationDate.getFullYear().toString();

    if (yearFilterValues.indexOf(orderYear) === -1) {
      yearFilterValues.push(orderYear);
    }

    if (yearFilter) {
      if (orderYear === yearFilter) {
        orders.push(customerOrder);
      }
    } else if (timeAgoFilter && orderCreationDate.getTime() > timeAgoFilter) {
      orders.push(customerOrder);
    }
  }

  return {
    orders: orders,
    yearFilters: yearFilterValues,
  };
}

/**
 * @description Returns a list of orders created with model
 * @param {dw.util.Iterator} orders - Chunk of orders
 * @param {object} config - Querystring properties
 * @returns {Array} List of orders created with model
 */
function createOrderObjects(orders, config) {
  const OrderModel = require("*/cartridge/models/order");
  let orderObjects = [];

  while (orders.hasNext()) {
    let order = orders.next();

    if ("isOffline" in order) {
      orderObjects.push(order);
    } else {
      orderObjects.push(
        new OrderModel(order, {
          config: config,
        }),
      );
    }
  }

  return orderObjects;
}

/**
 * @description Returns sorted array of orders for the current customer
 * @param {object} currentCustomer - Object with customer properties
 * @returns {Array} Array of orders
 */
function getOrdersSortedArray(currentCustomer) {
  const orderHistory = currentCustomer.raw.getOrderHistory();
  const Order = require("dw/order/Order");
  let orders = orderHistory
    .getOrders(
      "status!={0} AND status!={1}",
      "creationDate DESC",
      Order.ORDER_STATUS_REPLACED,
      Order.ORDER_STATUS_FAILED,
    )
    .asList()
    .toArray();

  const siteHelpers = require("*/cartridge/scripts/helpers/siteHelpers");
  const isOfflineOrdersDisplayEnabled = siteHelpers.getCustomPreference(
    "enableOfflineOrdersDisplay",
  );

  if (isOfflineOrdersDisplayEnabled && currentCustomer.raw && currentCustomer.raw.profile) {
    const offlineOrders = currentCustomer.raw.profile.custom.OfflineOrders;
    const email = currentCustomer.raw.profile.email;

    orders = mergeOfflineOrders(orders, offlineOrders, email);
  }

  return orders;
}

/**
 * @description Returns a list of orders for the current customer
 *
 * Was fully rewritten for performance purposes
 * @param {object} currentCustomer - Object with customer properties
 * @param {object} querystring - Querystring properties
 * @returns {object} Order history page data
 */
function getOrders(currentCustomer, querystring) {
  const orderModelConfig = {
    numberOfLineItems: "single",
  };

  let orders = getOrdersSortedArray(currentCustomer);

  const processFilteringResult = this.processFiltering(orders, querystring);
  const paging = this.getPaging(processFilteringResult.orders, querystring);

  return {
    orders: this.createOrderObjects(paging.pageElements, orderModelConfig),
    ordersCount: paging.count,
    filterValues: this.createFilters(processFilteringResult.yearFilters, querystring),
    showMore: this.getShowMore(paging, querystring),
  };
}

/**
 * @description Checks if order details allowed for current customer with provided details
 * @param {dw.order.Order} order - Order for checks
 * @param {object} currentCustomer - Object with customer properties
 * @param {string} email - Email for check
 * @param {boolean} skipAuthenticChecking - Skip checking order details params with track form params
 * @returns {boolean} Is an order allowed for displaying
 */
function isOrderDetailsAllowed(order, currentCustomer, email, skipAuthenticChecking) {
  let allowed = false;
  const Order = require("dw/order/Order");

  if (!order || order.status.value === Order.ORDER_STATUS_FAILED) {
    return allowed;
  }

  if (email) {
    allowed = String(order.customerEmail).toLowerCase() === String(email).toLowerCase();

    if (!skipAuthenticChecking) {
      allowed =
        allowed &&
        session.privacy.trackingEmail === email &&
        session.privacy.trackingOrderId === order.orderNo;
    }
  } else if (currentCustomer.profile) {
    allowed = currentCustomer.profile.customerNo === order.customerNo;
  }

  return allowed;
}

/**
 * @description Finds offline order by order ID for the current customer
 * @param {string} orderId - Order ID
 * @param {object} currentCustomer - Object with customer properties
 * @returns {object|null} Offline order object or null if not found
 */
function getOfflineOrderByOrderId(orderId, currentCustomer) {
  if (!orderId || !currentCustomer || !currentCustomer.raw || !currentCustomer.raw.profile) {
    return null;
  }

  const offlineOrders = currentCustomer.raw.profile.custom.OfflineOrders;

  if (!offlineOrders) {
    return null;
  }

  let email = currentCustomer.raw.profile.email;

  for (let i = 0; i < offlineOrders.length; i++) {
    let currentOfflineOrder = this.getOfflineOrderObjectFromJSON(offlineOrders[i], email);

    if (currentOfflineOrder.id === orderId) {
      return currentOfflineOrder;
    }
  }

  return null;
}

/**
 * @description Determines if COD + returnable products message should show
 * @param {object} orderModel - Order for checks
 * @returns {boolean} true/false
 */
function isShowCODReturnMessage(orderModel) {
  if (!orderModel) {
    return false;
  }

  const returnHelpers = require("*/cartridge/scripts/helpers/order/returnHelpers");

  const isCodMessageVisible = returnHelpers.isCodMessageVisibleOnReturnPortal();

  if (!isCodMessageVisible) {
    return false;
  }

  const isCODOrder = orderModel.isCODOrder;
  const hasReturnableProduct = orderModel.hasReturnableProduct;
  const isReturnable = orderModel.isReturnable;

  if (!isCODOrder || !hasReturnableProduct || !isReturnable) {
    return false;
  }

  return true;
}

/**
 * @description Shows non-returnable message if all products are non-returnable.
 * @param {object} order - Order for checks
 * @param {boolean} isNotifyNonReturnable - Is notify non returnable
 * @returns {boolean} true/false
 */
function isShowNonReturnableMessage(order, isNotifyNonReturnable) {
  if (!order) {
    return false;
  }

  if (!isNotifyNonReturnable) {
    return false;
  }

  const isOrderFullyReturned = order.overallOrderStatus === "returned";

  if (isOrderFullyReturned) {
    return false;
  }

  const noReturnableItem = !order.hasReturnableProduct;

  if (!order.isReturnable) {
    return false;
  }

  if (!noReturnableItem) {
    return false;
  }

  return true;
}

/**
 * @description Checks if the return button should be shown on the order details page
 * @param {object} orderModel - Order for checks
 * @returns {boolean} true/false
 */
function isShowReturnButton(orderModel) {
  if (!orderModel) {
    return false;
  }

  const hasReturnableItems = orderModel.hasReturnableProduct || orderModel.hasAnyReturnableProduct;

  return orderModel.isReturnable && hasReturnableItems && !orderModel.isCODOrder;
}

module.exports = orderHelpers;
module.exports.createOrderModelFromBasketAndRequest = createOrderModelFromBasketAndRequest;
module.exports.fillinOrderCustomAttributes = fillinOrderCustomAttributes;
module.exports.findCurrentAppleDevice = findCurrentAppleDevice;
module.exports.increaseEmployeeDiscountUsage = increaseEmployeeDiscountUsage;
module.exports.decreaseRegularEmployeeDiscountUsage = decreaseRegularEmployeeDiscountUsage;
module.exports.decrease1774EmployeeDiscountUsage = decrease1774EmployeeDiscountUsage;
module.exports.getOrders = getOrders;
module.exports.isOrderDetailsAllowed = isOrderDetailsAllowed;
module.exports.getOrderMainPaymentMethodID = getOrderMainPaymentMethodID;
module.exports.mergeOfflineOrders = mergeOfflineOrders;
module.exports.processFiltering = processFiltering;
module.exports.createOrderObjects = createOrderObjects;
module.exports.getOfflineOrderStatusParsed = getOfflineOrderStatusParsed;
module.exports.getOfflineOrderProductDetails = getOfflineOrderProductDetails;
module.exports.getOrdersSortedArray = getOrdersSortedArray;
module.exports.getOfflineOrderByOrderId = getOfflineOrderByOrderId;
module.exports.getOfflineOrderStoreInfo = getOfflineOrderStoreInfo;
module.exports.getOfflineOrderObjectFromJSON = getOfflineOrderObjectFromJSON;
module.exports.getLineItemImage = getLineItemImage;
module.exports.getProductNumber = getProductNumber;
module.exports.getPdpUrl = getPdpUrl;
module.exports.cloneLineItem = cloneLineItem;
module.exports.isShowCODReturnMessage = isShowCODReturnMessage;
module.exports.isShowNonReturnableMessage = isShowNonReturnableMessage;
module.exports.isShowReturnButton = isShowReturnButton;
module.exports.isPaidByGiftCertificate = isPaidByGiftCertificate;
