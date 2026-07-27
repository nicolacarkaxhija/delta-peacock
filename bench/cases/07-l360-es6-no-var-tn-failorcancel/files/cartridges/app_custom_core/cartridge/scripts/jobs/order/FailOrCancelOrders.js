"use strict";

/**
 * @module cartridges/int_jobs/cartridge/scripts/jobs/FailOrCancelOrders
 *
 * Fails or cancels orders provided in the CSV format
 * @param {string} localFolder : Target folder in IMPEX/src directory
 * @returns {string} : Message
 */

const File = require("dw/io/File");
const FileReader = require("dw/io/FileReader");
const CSVStreamReader = require("dw/io/CSVStreamReader");
const OrderMgr = require("dw/order/OrderMgr");
const Order = require("dw/order/Order");
const Logger = require("dw/system/Logger");
const Status = require("dw/system/Status");
const COHelpers = require("*/cartridge/scripts/checkout/checkoutHelpers");
const logger = Logger.getLogger("job.fail.orders");
const afterpayPaymentRefund = require("*/cartridge/scripts/checkout/afterpayPaymentRefund");

/**
 * Voids gift card holds on the order before failing it.
 *
 * @param {dw.order.Order} order - The order to void gift card holds for
 * @param {string} orderNumber - The order number
 * @returns {void}
 */
function voidGiftCardHolds(order, orderNumber) {
  const ProviderMgr = require("*/cartridge/scripts/util/ProviderMgr");
  const giftCertificateProvider = ProviderMgr.getGiftCertificateProvider();

  if (!giftCertificateProvider) {
    return;
  }

  const voidResult = giftCertificateProvider.voidGiftCardBalanceHolds(order);

  if (!voidResult.success) {
    logger.error(
      'Failed to void gift card holds for order "{0}": {1}',
      orderNumber,
      JSON.stringify(voidResult.errors),
    );
  }
}

/**
 * Cancels a payment based on the payment processor. Returns true if cancellation was successful, false otherwise.
 *
 * @param {dw.order.Order} order - The order for which to cancel the payment
 * @param {dw.order.PaymentInstrument} paymentInstrument - The payment instrument to cancel
 * @returns {boolean} true if cancellation was successful, false otherwise
 */
function cancelPaymentInstrument(order, paymentInstrument) {
  const adyenCheckout = require("*/cartridge/scripts/adyenCheckout");
  const paypalApi = require("*/cartridge/scripts/paypal/paypalApi");
  const shoppayAdminAPI = require("*/cartridge/scripts/shoppay/adminAPI");

  const paymentProcessorID = paymentInstrument.paymentTransaction.paymentProcessor.ID.toLowerCase();

  let result;

  if (paymentProcessorID.includes("clutch") || paymentProcessorID.includes("afterpay")) {
    return true; // Clutch and Afterpay payments are already handled in processInput function
  } else if (paymentProcessorID.includes("adyen")) {
    result = adyenCheckout.doCancelPaymentCall(paymentInstrument);
  } else if (paymentProcessorID.includes("paypal")) {
    result = paypalApi.cancelPayment(order);
  } else if (paymentProcessorID.includes("shoppay")) {
    result = shoppayAdminAPI.cancelPayment(order);
  } else {
    logger.warn(
      'Unknown payment processor "{0}" on order "{1}"',
      paymentProcessorID,
      order.orderNo,
    );

    return false;
  }

  if (!result || result.error || result.err) {
    return false;
  }

  return true;
}

/**
 * Cancels all order payments and, if successful, cancels the order. Otherwise, returns an error status.
 *
 * @param {dw.order.Order} order - The order to cancel
 * @returns {dw.system.Status} status
 */
function cancelOrder(order) {
  const paymentInstruments = order.getPaymentInstruments();

  let allPaymentsCancelled = true;

  paymentInstruments.toArray().forEach(function (paymentInstrument) {
    if (!cancelPaymentInstrument(order, paymentInstrument)) {
      allPaymentsCancelled = false;
    }
  });

  if (allPaymentsCancelled) {
    return OrderMgr.cancelOrder(order);
  }

  return new Status(Status.ERROR);
}

/**
 * Cancels or fails an order based on status.
 *
 * @param {dw.order.Order} order - The order to process
 * @param {string} orderNumber - The order number
 * @returns {boolean} true if the order was successfully cancelled or failed, false otherwise
 */
function cancelOrFailOrder(order, orderNumber) {
  const isNewOrOpen =
    order.status.value === Order.ORDER_STATUS_NEW || order.status.value === Order.ORDER_STATUS_OPEN;

  if (isNewOrOpen) {
    const cancellationResult = cancelOrder(order);

    if (cancellationResult.error) {
      logger.error(
        'Cannot cancel order "{0}". Error: {1}',
        orderNumber,
        cancellationResult.message,
      );

      return false;
    }

    COHelpers.sendCancellationEmail(order, order.customerLocaleID);

    logger.info('Successfully cancelled order "{0}"', orderNumber);
  } else {
    const failingResult = OrderMgr.failOrder(order, false);

    if (failingResult.error) {
      logger.error('Cannot fail order "{0}". Error: {1}', orderNumber, failingResult.message);

      return false;
    }

    logger.info('Successfully failed order "{0}"', orderNumber);
  }

  return true;
}

/**
 * Processing input stream and failing or cancelling orders.
 *
 * @param {dw.io.Reader} inputStream : input stream with the order numbers
 * @returns {boolean} true if all orders were processed successfully, false otherwise
 */
function processInput(inputStream) {
  const streamReader = new CSVStreamReader(inputStream, ",", '"');
  let line;
  let success = true;

  // eslint-disable-next-line no-cond-assign
  while ((line = streamReader.readNext()) !== null) {
    for (let i = 0; i < line.length; i++) {
      let orderNumber = line[i].trim();

      if (empty(orderNumber)) {
        continue;
      }

      let order = OrderMgr.searchOrder("orderNo = {0}", orderNumber);

      if (order === null) {
        logger.warn('Order "{0}" not found', orderNumber);

        continue;
      }

      voidGiftCardHolds(order, orderNumber);

      afterpayPaymentRefund.createPaymentRefund(order);

      if (!cancelOrFailOrder(order, orderNumber)) {
        success = false;
      }
    }
  }

  return success;
}

/**
 * The main function, called by the FailOrCancelOrders job
 *
 * @returns {dw.system.Status} - Status.OK if all existing orders were processed successfully, Status.ERROR otherwise
 */
function execute() {
  const params = arguments[0];
  const folderPath = "src" + File.SEPARATOR + params.localFolder;
  const folder = new File(File.IMPEX + File.SEPARATOR + folderPath);
  const archiveDirectory = new File(
    File.IMPEX + File.SEPARATOR + folderPath + File.SEPARATOR + "archive",
  );
  let success = true;
  let filePath;
  let filePaths;

  archiveDirectory.mkdirs();

  try {
    filePaths = folder.listFiles(function (candidate) {
      filePath = candidate;

      return candidate.isFile();
    });
  } catch (e) {
    logger.error("Error while processing {0}: {1}", filePath, e.message);

    return new Status(Status.ERROR, "ERROR");
  }

  if (filePaths.length === 0) {
    logger.error('No input files found at "{0}". Skipping...', folder.getFullPath());

    return new Status(Status.OK, "OK");
  }

  for (let i = 0; i < filePaths.getLength(); i++) {
    let inputFile = filePaths[i];

    logger.info("Started processing of {0}", inputFile.getFullPath());

    let fileReader = new FileReader(inputFile, "UTF-8");

    if (!processInput(fileReader)) {
      success = false;
    }

    let archiveFile = new File(archiveDirectory, inputFile.getName());

    inputFile.renameTo(archiveFile);

    logger.info("Processing of {0} finished.", inputFile.getFullPath());
  }

  return new Status(success ? Status.OK : Status.ERROR);
}

module.exports = {
  execute: execute,
};
