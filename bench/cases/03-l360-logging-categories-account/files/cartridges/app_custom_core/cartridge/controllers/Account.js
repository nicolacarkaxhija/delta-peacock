"use strict";

/**
 * @memberof app_custom_core
 * @category app_custom_core
 * @subcategory controllers
 * @module Account
 * @description Account controller uses for My Account functionality.
 *
 * Replaced because:
 * - Provider approach used to send emails
 */

const CustomerMgr = require("dw/customer/CustomerMgr");
const Resource = require("dw/web/Resource");
const URLUtils = require("dw/web/URLUtils");

const server = require("server");
const csrfProtection = require("*/cartridge/scripts/middleware/csrf");
const consentTracking = require("*/cartridge/scripts/middleware/consentTracking");
const breadcrumbs = require("*/cartridge/scripts/middleware/breadcrumbs");
const ProviderMgr = require("*/cartridge/scripts/util/ProviderMgr");
const analytics = require("*/cartridge/scripts/middleware/analytics");
const pageBrand = require("*/cartridge/scripts/middleware/pageBrand");
const pageMetaData = require("*/cartridge/scripts/middleware/pageMetaData");
const accountNavigation = require("*/cartridge/scripts/middleware/accountNavigation");
const userLoggedIn = require("*/cartridge/scripts/middleware/userLoggedIn");
const subscription = require("*/cartridge/scripts/middleware/subscription");
const captchaMiddleware = require("*/cartridge/scripts/middleware/captcha");
const loyaltyMiddleware = require("*/cartridge/scripts/middleware/loyalty");
const ROUTE_BEFORE_COMPLETE = "route:BeforeComplete";

server.extend(module.superModule);

/**
 * @name Account-PasswordResetDialogForm
 * @function
 * @description Handles customer reset password request
 *
 * Replaced because:
 * - Provider approach used to send the reset password email
 *
 * Prepend:
 * - *server.middleware.post* - Allows only POST requests
 * - *server.middleware.https* - Allows only HTTPS requests
 * - *csrfProtection.validateAjaxRequest* - Allows only AJAX requests
 */
server.replace(
  "PasswordResetDialogForm",
  server.middleware.post,
  server.middleware.https,
  csrfProtection.validateAjaxRequest,
  function (req, res, next) {
    const validator = require("*/cartridge/scripts/forms/validator");
    const formErrors = require("*/cartridge/scripts/formErrors");

    const resetPasswordForm = server.forms.getForm("profile").resetPassword;
    const emailInputName = resetPasswordForm.email.htmlName;

    if (resetPasswordForm.valid) {
      const email = resetPasswordForm.email.htmlValue;
      let response = {
        success: true,
        fieldErrors: {},
      };

      if (email) {
        if (validator.validateEmail(email)) {
          let resettingCustomer = CustomerMgr.getCustomerByLogin(email);
          let mobile = req.querystring.mobile;
          const ESProvider = ProviderMgr.getESProvider();

          if (resettingCustomer && ESProvider) {
            ESProvider.accountPasswordResetEmail(resettingCustomer, req.querystring.rurl);
          }

          res.json({
            success: true,
            confirmationResponse: true,
            receivedMsgHeading: Resource.msg("passwordReset.title.confirmation", "login", null),
            receivedMsgBody: Resource.msg("passwordReset.message.confirmation", "login", null),
            buttonText: Resource.msg("button.text.loginform", "login", null),
            mobile: mobile === "true",
            returnUrl: URLUtils.url("Login-Show").toString(),
          });
        } else {
          response.success = false;
          response.fieldErrors[emailInputName] = Resource.msg(
            "error.message.passwordreset",
            "login",
            null,
          );
          res.json(response);
        }
      } else {
        response.success = false;
        response.fieldErrors[emailInputName] = Resource.msg(
          "error.message.required",
          "login",
          null,
        );
        res.json(response);
      }

      return next();
    } else {
      res.json({
        success: false,
        fieldErrors: formErrors.getFormErrors(resetPasswordForm),
      });
    }

    return next();
  },
);

/**
 * @name Account-SaveNewPassword
 * @function
 * @description Handles new customer password saving
 *
 * Replaced because:
 * - Provider approach used to send the reset password confirmation email
 *
 * Prepend:
 * - *server.middleware.post* - Allows only POST requests
 * - *server.middleware.https* - Allows only HTTPS requests
 * - *csrfProtection.validateAjaxRequest* - Allows only AJAX requests
 */
server.replace(
  "SaveNewPassword",
  server.middleware.post,
  server.middleware.https,
  csrfProtection.validateAjaxRequest,
  function (req, res, next) {
    const Transaction = require("dw/system/Transaction");
    const formErrors = require("*/cartridge/scripts/formErrors");
    const accountHelpers = require("*/cartridge/scripts/helpers/accountHelpers");

    const passwordForm = server.forms.getForm("profile");
    const token = passwordForm.login.newpasswords.token;
    let newPasswordsForm = passwordForm.login.newpasswords;
    let newPassword = passwordForm.login.newpasswords.newpassword;
    let newPasswordConfirm = passwordForm.login.newpasswords.newpasswordconfirm;

    if (newPassword.value !== newPasswordConfirm.value) {
      newPasswordsForm.valid = false;
      newPassword.valid = false;
      newPasswordConfirm.valid = false;
      newPasswordConfirm.error = Resource.msg("error.message.mismatch.newpassword", "forms", null);
    }

    if (!newPasswordsForm.valid) {
      res.json({
        newPasswordsForm: newPasswordsForm,
        success: false,
        fieldErrors: formErrors.getFormErrors(newPasswordsForm),
        token: token,
      });

      return next();
    }

    let result = {
      success: true,
      newPassword: newPassword.value,
      newPasswordConfirm: newPasswordConfirm.value,
      token: token.value,
      newPasswordsForm: newPasswordsForm,
    };

    res.json(result);

    this.on(ROUTE_BEFORE_COMPLETE, function (req, res) {
      // eslint-disable-line no-shadow
      const formInfo = res.getViewData();
      let status = {
        error: true,
      };
      let resettingCustomer;

      Transaction.wrap(function () {
        resettingCustomer = formInfo.token ? CustomerMgr.getCustomerByToken(formInfo.token) : null;

        if (resettingCustomer) {
          status = resettingCustomer.profile.credentials.setPasswordWithToken(
            formInfo.token,
            formInfo.newPassword,
          );
          accountHelpers.updateMigratedStatus(resettingCustomer, false);
        }
      });

      if (status.error) {
        newPassword.valid = false;
        newPasswordConfirm.valid = false;
        newPassword.error = Resource.msg(
          "error.message.resetpassword.invalidformentry",
          "forms",
          null,
        );
        res.json({
          newPassword: newPassword,
          success: false,
          fieldErrors: formErrors.getFormErrors(newPasswordsForm),
          token: token,
        });
      } else {
        const url = accountHelpers.getLoginRedirectURLOnPasswordSave(
          req,
          resettingCustomer,
          formInfo.newPassword,
        );

        server.forms.getForm("login").clear();

        const espProvider = ProviderMgr.getESProvider();

        if (espProvider) {
          espProvider.accountPasswordChangeConfirmationEmail(resettingCustomer);
        }

        res.json({
          success: true,
          redirectUrl: url,
        });
      }
    });

    return next();
  },
);

/**
 * @name Account-SubmitRegistration
 * @function
 * @description Endpoint that gets hit when a shopper submits their registration for a new account
 *
 * Prepend:
 * - *captchaMiddleware.ensureCaptchaProvidedInFormData* - Checks if recaptcha has some value in a form
 */
server.prepend(
  "SubmitRegistration",
  captchaMiddleware.ensureCaptchaProvidedInFormData("profile", "login"),
);

/**
 * @name Account-SubmitRegistration
 * @function
 * @description Reads the loyalty opt-in checkbox from the registration form
 */
server.append("SubmitRegistration", function (req, res, next) {
  const registrationForm = server.forms.getForm("profile");
  const joinLoyalty = registrationForm.customer.joinLoyalty
    ? registrationForm.customer.joinLoyalty.checked
    : false;

  res.setViewData({
    joinLoyalty: !!joinLoyalty,
  });

  next();
});

/**
 * @name Account-StartRegister
 * @function
 * @description Renders register page.
 *
 * Append:
 * - *subscription.addSubscriptionData* - Adds subscription data to the response view data
 * - *captchaMiddleware.addCaptchaToForms* - Adds information about forms enabled for recaptcha
 * - *loyaltyMiddleware.addLoyaltyOptInFlag* - Adds Yotpo loyalty enabled flag for loyalty opt-in checkbox
 */
server.append(
  "StartRegister",
  subscription.addSubscriptionData,
  captchaMiddleware.addCaptchaToForms(["profile"]),
  loyaltyMiddleware.addLoyaltyOptInFlag,
);

/**
 * @name Account-StartRegisterEmployee
 * @function
 * @description Renders register page for employees.
 *
 * Append:
 * - *captchaMiddleware.addCaptchaToForms* - Adds information about forms enabled for recaptcha
 */
server.append("StartRegisterEmployee", captchaMiddleware.addCaptchaToForms(["profile"]));

/**
 * @name Account-StartRegisterPartnerEmployee
 * @function
 * @description Renders register page for employees.
 *
 * Append:
 * - *captchaMiddleware.addCaptchaToForms* - Adds information about forms enabled for recaptcha
 */
server.append("StartRegisterPartnerEmployee", captchaMiddleware.addCaptchaToForms(["profile"]));

/**
 * @name Account-ShowMiniAccountDialog
 * @function
 * @description Renders the mini account dialog.
 *
 * Append:
 * - *captchaMiddleware.addCaptchaToForms* - Adds information about forms enabled for recaptcha
 */
server.prepend("ShowMiniAccountDialog", captchaMiddleware.addCaptchaToForms(["login"]));

/**
 * @name Account-SubscriptionPreferences
 * @function
 * @description Account Subscription Preferences Page.
 *
 * Append:
 * - *captchaMiddleware.addCaptchaToForms* - Adds information about forms enabled for recaptcha
 */
server.append("SubscriptionPreferences", captchaMiddleware.addCaptchaToForms(["subscriptions"]));

/**
 * @name Account-UpdateSubscriptionPreferences
 * @function
 * @description Update Customer Subscriptions
 *
 * Prepend:
 * - *captchaMiddleware.ensureCaptchaProvidedInFormData* - Checks if recaptcha has some value in a form
 */
server.prepend(
  "UpdateSubscriptionPreferences",
  captchaMiddleware.ensureCaptchaProvidedInFormData("subscriptions"),
);

/**
 * @name Account-Login
 * @function
 * @description Handles customer login request.
 *
 * Append:
 * - Replace the redirect logic to reload if required
 */
server.append("Login", function (req, res, next) {
  const viewData = res.getViewData();
  const isReload = req.querystring.reload;

  if (viewData.success && viewData.authenticatedCustomer && isReload) {
    res.setViewData({
      isReload: true,
      redirectUrl: null,
    });
  }

  if (viewData.authenticatedCustomer) {
    const loyaltyProvider = ProviderMgr.getLoyaltyProvider();
    const customerProfile = viewData.authenticatedCustomer.profile;

    if (
      customerProfile &&
      loyaltyProvider &&
      loyaltyProvider.isLoyaltyEnabled() &&
      loyaltyProvider.isMember(viewData.authenticatedCustomer)
    ) {
      loyaltyProvider.updateCustomerDataFromLoyaltySystem(customerProfile);
    }
  }

  next();
});

/**
 * @name Account-SaveNewPassword
 * @function
 * @description Handles new customer password saving
 *
 * Append:
 * - *analytics.addPageData* - Adds analytics page data
 */
server.append("SaveNewPassword", analytics.addPageData);

/**
 * @name Account-SubscriptionPreferences
 * @function
 * @description Account Subscription Preferences Page.
 *
 * Append:
 * - breadcrumbs logic changed
 * - *breadcrumbs.addCurrentPageToBreadcrumbs* - Adds breadcrumbs to viewData by specified params
 * - *breadcrumbs.generateListSchema* - Generating a List Schema for breadcrumbs
 */
server.append(
  "SubscriptionPreferences",
  breadcrumbs.addMyAccountBreadcrumbs,
  breadcrumbs.generateListSchema,
  breadcrumbs.addCurrentPageToBreadcrumbs("navigation.newsletter", "account"),
);

/**
 * @name Account-Header
 * @function
 * @description Extends the Account-Header endpoint to pass the is1774Page parameter
 *
 * Append:
 * - *pageBrand.handle1774Page* - Adds is1774Page parameter
 */
server.append("Header", pageBrand.handle1774Page);

/**
 * @name Account-UpdateSubscriptionPreferences
 * @function
 * @description Handles update of subscription preferences for the current customer.
 *
 * Append:
 * - Adds SMS subscription on the preference update
 */
server.append("UpdateSubscriptionPreferences", function (req, res, next) {
  const siteHelpers = require("*/cartridge/scripts/helpers/siteHelpers");

  if (!siteHelpers.isCountryIncludedInList("enableSMSSubscriptionByCountry")) {
    return next();
  }

  var subscriptionsForm = server.forms.getForm("subscriptions");

  if (!subscriptionsForm.valid) {
    return next();
  }

  var currentCustomer = req.currentCustomer.raw;

  if (!currentCustomer || !currentCustomer.profile || !currentCustomer.profile.phoneHome) {
    return next();
  }

  const hooksHelper = require("*/cartridge/scripts/helpers/hooks");
  const email = currentCustomer.profile.email;
  const phone = currentCustomer.profile.phoneHome;
  const newSubscriptionPreferences = subscriptionsForm.communicationTypes.value
    ? subscriptionsForm.communicationTypes.value.split(",")
    : [];

  if (
    newSubscriptionPreferences.length &&
    !subscriptionsForm.unsubscribe.value &&
    newSubscriptionPreferences.indexOf("sms") > -1
  ) {
    hooksHelper(
      "app.smsMarketing.subscribe",
      "subscribeSMS",
      {
        email: email,
        phone: phone,
        subscriptionSource: "account",
      },
      function () {},
    );
  }

  return next();
});

server.get(
  "EmployeeBenefits",
  server.middleware.https,
  userLoggedIn.validateLoggedIn,
  pageMetaData.computedPageMetaData,
  pageMetaData.hrefLang,
  accountNavigation.generateNavigationMenuItems,
  breadcrumbs.addMyAccountBreadcrumbs,
  breadcrumbs.generateListSchema,
  breadcrumbs.addCurrentPageToBreadcrumbs("navigation.employee.discount", "account"),
  function (req, res, next) {
    const employeeNumber = customer.profile.custom.employeeNumber;
    const EmployeeMgr = require("*/cartridge/scripts/customObjects/employee/EmployeeMgr");
    const employee = EmployeeMgr.getEmployeeById(employeeNumber);
    const sitepref = require("util/sitepref");
    const currentCountry = sitepref.getCurrentShopCountryCode();

    if (!employee || employee.countryCode !== currentCountry) {
      res.redirect(URLUtils.url("Home-ErrorNotFound"));

      return next();
    }

    const employeeHelpers = require("*/cartridge/scripts/helpers/employeeHelpers");
    const discountRates = employeeHelpers.getDiscountRates();
    const hasFreeShipping = employeeHelpers.hasFreeShipping();
    const currentYear = new Date().getFullYear().toString() + ":";

    res.render("account/employeeDiscount", {
      pageContext: "employeeSale",
      discountRateRegular: discountRates.promotionRegular,
      discountRate1774: discountRates.promotion1774,
      hasFreeShipping: hasFreeShipping,
      employee: employee,
      currentYear: currentYear,
    });

    return next();
  },
);

/**
 * Account-ShowQRCode : The Account-ShowQRCode endpoint renders the account QR code page for the logged-in shopper.
 * It displays the shopper's unique QR code used for account-related actions.
 *
 * @name Base/Account-ShowQRCode
 * @function
 * @memberof Account
 * @param {middleware} - server.middleware.https
 * @param {middleware} - userLoggedIn.validateLoggedIn
 * @param {category} - sensitive
 * @param {renders} - isml
 * @param {serverfunction} - get
 */
server.get(
  "ShowQRCode",
  server.middleware.https,
  userLoggedIn.validateLoggedIn,
  function (req, res, next) {
    const currentCustomer = req.currentCustomer.raw;
    const { couponId, sfccCouponId, validUntil } = req.querystring || {};

    // Coupon QR Code rendering
    if (couponId) {
      res.render("account/loyalty/couponQRCode", {
        couponId: couponId,
        sfccCouponId: sfccCouponId,
        validUntil: validUntil,
      });

      return next();
    }

    if (!currentCustomer) {
      return next();
    }

    const profile = currentCustomer.profile;

    if (!profile || !profile.custom || !profile.custom.BenexyID) {
      return next();
    }

    const BenexyID = profile.custom.BenexyID;

    // Account QR Code rendering
    res.render("account/loyalty/accountQRCode", {
      BenexyID: BenexyID,
    });

    return next();
  },
);

/*
 * Prepends Account's 'Show' function to update view data.
 */
server.prepend(
  "Show",
  server.middleware.https,
  userLoggedIn.validateLoggedIn,
  consentTracking.consent,
  function (req, res, next) {
    const currentCustomer = req.currentCustomer.raw;

    if (!currentCustomer) {
      next();
    }

    const profile = currentCustomer.profile;

    if (!profile || !profile.custom || !profile.custom.userID) {
      next();
    }

    const loyaltyProvider = ProviderMgr.getLoyaltyProvider();
    let viewData = res.getViewData();

    if (loyaltyProvider) {
      viewData.profileForm = server.forms.getForm("profile");

      Object.assign(viewData, loyaltyProvider.getAccountDashboardViewData(profile));

      if (loyaltyProvider.isLoyaltyEnabled() && loyaltyProvider.isMember(currentCustomer)) {
        viewData.loyaltyData = loyaltyProvider.getCustomerLoyaltyData(profile.email);
      }
    }

    res.setViewData(viewData);

    next();
  },
);

/*
 * Prepends Account's 'Membership' function to update view data.
 */
server.prepend(
  "Membership",
  server.middleware.https,
  userLoggedIn.validateLoggedIn,
  consentTracking.consent,
  pageMetaData.computedPageMetaData,
  accountNavigation.generateNavigationMenuItems,
  function (req, res, next) {
    const javengoHelper = require("*/cartridge/scripts/javengo/javengoHelper");
    const accountHelper = require("*/cartridge/scripts/helpers/accountHelpers");
    const siteHelpers = require("*/cartridge/scripts/helpers/siteHelpers");
    const loyaltyHelpers = require("*/cartridge/scripts/helpers/loyalty.js");

    let viewData = res.getViewData();
    const currentCustomer = req.currentCustomer.raw;
    const isLoyaltyEnabled = ProviderMgr.getLoyaltyProvider().isLoyaltyEnabled();
    const isBirthdayCouponsEnabled = siteHelpers.isCountryIncludedInList("enableBirthdayCoupons");
    const profile = currentCustomer && currentCustomer.profile ? currentCustomer.profile : null;

    if (!profile || !profile.custom || !profile.custom.userID) {
      next();
    }

    const userID = profile.custom.userID;

    viewData.isLoyaltyEnabled = isLoyaltyEnabled;
    viewData.isBirthdayCouponsEnabled = isBirthdayCouponsEnabled;
    viewData.currentCustomer = profile;

    // Birthday coupons logic
    if (
      isBirthdayCouponsEnabled &&
      javengoHelper.isJavengoEnabled() &&
      accountHelper.showBirthdayVoucher(profile)
    ) {
      const birthdayCoupons = javengoHelper.getCustomerValidCoupons(userID);

      viewData.coupons = birthdayCoupons;
      viewData.isBirthdayVoucherAvailable = birthdayCoupons.length > 0;
    }

    // Loyalty logic
    if (isLoyaltyEnabled) {
      const accountModel = accountHelper.getModel(req);
      const coupons = javengoHelper.getCustomerValidCoupons(userID);
      const invalidCoupons = javengoHelper.getCustomerInvalidCoupons(userID);
      const nextRecalculationDate = loyaltyHelpers.getNextRecalculationDate();

      viewData.nextRecalculationDate = nextRecalculationDate;

      // Valid coupons
      viewData.coupons = coupons;
      viewData.couponsCount = coupons.length;

      // Invalid (expired or redeemed) coupons
      viewData.invalidCoupons = invalidCoupons;
      viewData.invalidCouponsCount = invalidCoupons.length;
      viewData.account = accountModel;
      viewData.showInvalidCouponsAccordion = true;
    }

    res.setViewData(viewData);

    next();
  },
);

/**
 * @name Account-GetValidLoyaltyCoupons
 * @function
 * @description JSON polling endpoint for delayed loyalty coupons
 */
server.get(
  "GetValidLoyaltyCoupons",
  server.middleware.https,
  userLoggedIn.validateLoggedIn,
  function (req, res, next) {
    const javengoHelper = require("*/cartridge/scripts/javengo/javengoHelper");
    const Logger = require("dw/system/Logger");

    try {
      const currentCustomer = req.currentCustomer.raw;

      if (!currentCustomer || !currentCustomer.profile) {
        res.json({ success: false });

        return next();
      }

      const profile = currentCustomer.profile;

      if (!profile.custom || !profile.custom.userID) {
        res.json({ success: false });

        return next();
      }

      if (!ProviderMgr.getLoyaltyProvider().isLoyaltyEnabled()) {
        res.json({
          success: true,
          couponsCount: 0,
          coupons: [],
        });

        return next();
      }

      const userID = profile.custom.userID;
      const start = Date.now();

      Logger.info("Loyalty polling starting for customer {0}", userID);
      const coupons = javengoHelper.getCustomerValidCoupons(userID);
      const duration = ((Date.now() - start) / 1000).toFixed(2);

      if (!coupons || coupons.length === 0) {
        Logger.info(
          "Loyalty polling result for customer {0}. Response time {1} seconds. No coupons found yet.",
          userID,
          duration,
        );
        res.json({
          success: true,
          couponsCount: 0,
          coupons: [],
        });

        return next();
      }

      Logger.info(
        "Loyalty polling result for customer {0}. Response time {1} seconds. Coupons found: {2}",
        userID,
        duration,
        coupons.length,
      );

      const renderTemplateHelper = require("*/cartridge/scripts/renderTemplateHelper");

      const html = renderTemplateHelper.getRenderedHtml(
        {
          coupons: coupons,
        },
        "account/loyalty/loyaltyCouponsList",
      );

      res.json({
        success: true,
        couponsCount: coupons.length,
        html: html,
      });
    } catch (e) {
      Logger.error("Loyalty polling failed: {0}", e.message);
      res.json({ success: false });
    }

    return next();
  },
);

/*
 * Prepends Account's 'EditProfile' function to update view data.
 */
server.prepend(
  "EditProfile",
  server.middleware.https,
  csrfProtection.generateToken,
  userLoggedIn.validateLoggedIn,
  consentTracking.consent,
  pageMetaData.computedPageMetaData,
  accountNavigation.generateNavigationMenuItems,
  function (req, res, next) {
    const isLoyaltyEnabled = ProviderMgr.getLoyaltyProvider().isLoyaltyEnabled();
    let viewData = res.getViewData();

    viewData.isLoyaltyEnabled = isLoyaltyEnabled;
    res.setViewData(viewData);

    next();
  },
);

/*
 * Prepends Account's 'SubscriptionPreferences' function to update view data.
 */
server.prepend(
  "SubscriptionPreferences",
  server.middleware.https,
  csrfProtection.generateToken,
  userLoggedIn.validateLoggedIn,
  consentTracking.consent,
  pageMetaData.computedPageMetaData,
  accountNavigation.generateNavigationMenuItems,
  function (req, res, next) {
    const isLoyaltyEnabled = ProviderMgr.getLoyaltyProvider().isLoyaltyEnabled();
    let viewData = res.getViewData();

    viewData.isLoyaltyEnabled = isLoyaltyEnabled;
    res.setViewData(viewData);

    next();
  },
);

module.exports = server.exports();
