"use strict";

const Calendar = require("dw/util/Calendar");
const Mail = require("dw/net/Mail");
const Order = require("dw/order/Order");
const OrderMgr = require("dw/order/OrderMgr");
const Status = require("dw/system/Status");
const StringUtils = require("dw/util/StringUtils");
const Logger = require("dw/system/Logger").getLogger("order.export.sox");

const ORDER_STATUS_MAP = {};

ORDER_STATUS_MAP[Order.ORDER_STATUS_CREATED] = "CREATED";
ORDER_STATUS_MAP[Order.ORDER_STATUS_NEW] = "NEW";
ORDER_STATUS_MAP[Order.ORDER_STATUS_OPEN] = "OPEN";
ORDER_STATUS_MAP[Order.ORDER_STATUS_COMPLETED] = "COMPLETED";
ORDER_STATUS_MAP[Order.ORDER_STATUS_CANCELLED] = "CANCELLED";
ORDER_STATUS_MAP[Order.ORDER_STATUS_REPLACED] = "REPLACED";
ORDER_STATUS_MAP[Order.ORDER_STATUS_FAILED] = "FAILED";

const ALLOWED_FIELDS = ["orderNo", "total", "currency", "status"];
const DEFAULT_FIELDS = "orderNo,total,currency,status";
const DEFAULT_EXPORT_DELAY = 7;
const DATE_FORMAT = "yyyy-MM-dd";
const CSV_SEPARATOR = ",";

/**
 * Returns the string label for an order status value.
 *
 * @param {number} statusValue - Numeric order status
 * @returns {string} Human-readable status label
 */
function getOrderStatusLabel(statusValue) {
  return ORDER_STATUS_MAP[statusValue] || String(statusValue);
}

/**
 * Calculates the target export date: today minus the delay in days.
 *
 * @param {number} delayDays - Number of days to subtract from today
 * @returns {{start: Date, end: Date, label: string}} Target date range (full day) and formatted label
 */
function getTargetDateRange(delayDays) {
  const cal = new Calendar();

  cal.add(Calendar.DAY_OF_YEAR, -delayDays);
  cal.set(Calendar.HOUR_OF_DAY, 0);
  cal.set(Calendar.MINUTE, 0);
  cal.set(Calendar.SECOND, 0);
  cal.set(Calendar.MILLISECOND, 0);
  const start = cal.getTime();
  const label = StringUtils.formatCalendar(cal, DATE_FORMAT);
  const fileLabel = StringUtils.formatCalendar(cal, "yyMMdd");

  cal.add(Calendar.DAY_OF_YEAR, 1);
  const end = cal.getTime();

  return { start: start, end: end, label: label, fileLabel: fileLabel };
}

/**
 * Resolves and validates the list of order fields to include in the CSV.
 *
 * @param {string} orderFieldsParam - Comma-separated field names from job parameter
 * @returns {string[]} Validated list of field names
 */
function resolveFields(orderFieldsParam) {
  let raw = orderFieldsParam && orderFieldsParam.trim() ? orderFieldsParam : DEFAULT_FIELDS;

  return raw
    .split(",")
    .map(function (field) {
      return field.trim();
    })
    .filter(function (field) {
      return ALLOWED_FIELDS.indexOf(field) !== -1;
    });
}

/**
 * Retrieves the field value from an order for CSV output.
 *
 * @param {dw.order.Order} order - The order object
 * @param {string} field - Field name
 * @returns {string} String value suitable for CSV
 */
function getOrderFieldValue(order, field) {
  switch (field) {
    case "orderNo":
      return order.orderNo || "";
    case "total":
      return order.totalGrossPrice ? order.totalGrossPrice.value.toFixed(2) : "0.00";
    case "currency":
      return order.currencyCode || "";
    case "status":
      return getOrderStatusLabel(order.status);
    default:
      return "";
  }
}

/**
 * Escapes a CSV field value to handle commas, quotes, and newlines.
 *
 * @param {string} value - Raw field value
 * @returns {string} Escaped CSV field
 */
function escapeCsvField(value) {
  const str = String(value);

  if (str.indexOf(CSV_SEPARATOR) !== -1 || str.indexOf('"') !== -1 || str.indexOf("\n") !== -1) {
    return '"' + str.replace(/"/g, '""') + '"';
  }

  return str;
}

// Buffers filled by the processOrders callback; reset by buildCsv before each run.
let exportFields = [];
let rows = [];

/**
 * Returns the query for orders exported to OMS (IBM export status = EXPORTED)
 * within a creation date range. Placeholders: {0} export status, {1} range
 * start (inclusive), {2} range end (exclusive).
 *
 * @returns {string} Query string for OrderMgr.processOrders
 */
function getOrderQuery() {
  return "exportStatus = {0} AND creationDate >= {1} AND creationDate < {2}";
}

/**
 * OrderMgr.processOrders callback: collects one CSV row per order into the
 * module-level rows buffer using the configured export fields.
 *
 * @param {dw.order.Order} order - Order to collect
 */
function collectOrderRow(order) {
  let line = exportFields
    .map(function (field) {
      return escapeCsvField(getOrderFieldValue(order, field));
    })
    .join(CSV_SEPARATOR);

  rows.push({ creationTime: order.creationDate.getTime(), line: line });
}

/**
 * Builds a CSV string from all orders exported within the given date range,
 * sorted by order creation date (processOrders does not support sorting).
 *
 * @param {Date} startDate - Start of the target creation date range (inclusive)
 * @param {Date} endDate - End of the target creation date range (exclusive)
 * @param {string[]} fields - Fields to include
 * @returns {{content: string, rowCount: number}} Complete CSV content and row count
 */
function buildCsv(startDate, endDate, fields) {
  exportFields = fields;
  rows = [];

  OrderMgr.processOrders(
    module.exports.collectOrderRow,
    module.exports.getOrderQuery(),
    Order.EXPORT_STATUS_EXPORTED,
    startDate,
    endDate,
  );

  rows.sort(function (a, b) {
    return a.creationTime - b.creationTime;
  });

  const lines = [fields.join(CSV_SEPARATOR)].concat(
    rows.map(function (row) {
      return row.line;
    }),
  );

  return { content: lines.join("\n"), rowCount: rows.length };
}

/**
 * Parses and normalizes the job step arguments.
 *
 * @param {dw.util.HashMap} args - Raw step arguments
 * @returns {object} Normalized config
 */
function normalizeArgs(args) {
  const delayRaw = args && args.exportDelay != null ? Number(args.exportDelay) : NaN;
  const exportDelay = Number.isNaN(delayRaw) || delayRaw < 0 ? DEFAULT_EXPORT_DELAY : delayRaw;

  const recipientsRaw = args && typeof args.recipients === "string" ? args.recipients : "";
  const recipients = recipientsRaw
    .split(",")
    .map(function (r) {
      return r.trim();
    })
    .filter(function (r) {
      return r.length > 0;
    });

  const mailFrom = args && typeof args.mailFrom === "string" ? args.mailFrom.trim() : "";
  const fields = resolveFields(args && args.orderFields);
  const isDisabled = Boolean(args && args.IsDisabled);

  return {
    exportDelay: exportDelay,
    recipients: recipients,
    mailFrom: mailFrom,
    fields: fields,
    isDisabled: isDisabled,
  };
}

/**
 * Sends the SOX export CSV as an email attachment to the configured recipients.
 *
 * @param {object} config - Email configuration
 * @param {string} dateLabel - Target date label for subject
 * @param {string} csvContent - CSV content to attach
 * @param {string} fileName - Attachment file name
 * @returns {boolean} True when the email was sent without errors
 */
function sendExportEmail(config, dateLabel, csvContent, fileName) {
  const boundary = "sox_" + new Date().getTime();
  const csvBase64 = StringUtils.encodeBase64(csvContent);
  const htmlBody =
    "<p>Orders exported to OMS for <strong>" +
    dateLabel +
    "</strong>. Please find the attached report.</p>";

  const mimeBody = [
    "--" + boundary,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    htmlBody,
    "",
    "--" + boundary,
    "Content-Type: text/csv; charset=UTF-8",
    'Content-Disposition: attachment; filename="' + fileName + '"',
    "Content-Transfer-Encoding: base64",
    "",
    csvBase64,
    "",
    "--" + boundary + "--",
  ].join("\r\n");

  const mail = new Mail();

  config.recipients.forEach(function (recipient) {
    mail.addTo(recipient);
  });

  mail.setFrom(config.mailFrom);
  mail.setSubject("SOX Orders Export - " + dateLabel);
  mail.setContent(mimeBody, 'multipart/mixed; boundary="' + boundary + '"', "UTF-8");

  const sendStatus = mail.send();

  return !sendStatus.error;
}

/**
 * Entry point for the OrderExportSOX job step.
 *
 * Queries orders exported to OMS for the configured target date (today minus
 * export delay days), builds a CSV report, and sends it to the configured
 * email recipients.
 *
 * @param {dw.util.HashMap} args - Job step parameters
 * @returns {dw.system.Status} Step execution status
 */
function execute(args) {
  const config = normalizeArgs(args);

  if (config.isDisabled) {
    return new Status(Status.OK, "OK", "Step disabled, skipping.");
  }

  if (!config.recipients.length) {
    Logger.error("OrderExportSOX: No email recipients configured.");

    return new Status(Status.ERROR, "ERROR", "No email recipients configured.");
  }

  if (!config.mailFrom) {
    Logger.error("OrderExportSOX: No sender email (mailFrom) configured.");

    return new Status(Status.ERROR, "ERROR", "No sender email configured.");
  }

  if (!config.fields.length) {
    Logger.error("OrderExportSOX: No valid order fields configured.");

    return new Status(Status.ERROR, "ERROR", "No valid order fields configured.");
  }

  const targetDate = getTargetDateRange(config.exportDelay);

  Logger.info("OrderExportSOX: Querying orders for date " + targetDate.label);

  const csvResult = buildCsv(targetDate.start, targetDate.end, config.fields);

  if (!csvResult.rowCount) {
    Logger.warn("OrderExportSOX: No exported orders found for " + targetDate.label);

    return new Status(Status.OK, "OK", "No exported orders found for " + targetDate.label);
  }

  Logger.info(
    "OrderExportSOX: Collected " + csvResult.rowCount + " orders for " + targetDate.label,
  );

  const csvContent = csvResult.content;
  const fileName = "SOX_Orders_" + targetDate.fileLabel + ".csv";

  Logger.info("OrderExportSOX: Sending report email for " + targetDate.label);

  const emailSent = sendExportEmail(config, targetDate.label, csvContent, fileName);

  if (!emailSent) {
    Logger.error("OrderExportSOX: Failed to send export email for " + targetDate.label);

    return new Status(Status.ERROR, "ERROR", "Failed to send export email.");
  }

  Logger.info("OrderExportSOX: Completed successfully for " + targetDate.label);

  return new Status(Status.OK, "OK", "SOX export email sent for " + targetDate.label);
}

module.exports = {
  execute: execute,
  getOrderQuery: getOrderQuery,
  collectOrderRow: collectOrderRow,
};
