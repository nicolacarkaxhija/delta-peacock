'use strict';

const Calendar = require('dw/util/Calendar');
const Mail = require('dw/net/Mail');
const Order = require('dw/order/Order');
const OrderMgr = require('dw/order/OrderMgr');
const Status = require('dw/system/Status');
const StringUtils = require('dw/util/StringUtils');
const Logger = require('dw/system/Logger').getLogger('job', 'job.reports.dailysales');

const CSV_SEPARATOR = ';';
const ALLOWED_FIELDS = ['orderNo', 'creationDate', 'currencyCode', 'totalGrossPrice', 'status', 'channel'];

/**
 * Resolves the calendar day to report on: yesterday, in the site time zone.
 *
 * @returns {{start: Date, end: Date, label: string}} Day range and label
 */
function getReportDay() {
    const calendar = new Calendar();

    calendar.set(Calendar.HOUR_OF_DAY, 0);
    calendar.set(Calendar.MINUTE, 0);
    calendar.set(Calendar.SECOND, 0);
    calendar.set(Calendar.MILLISECOND, 0);

    const end = calendar.getTime();

    calendar.add(Calendar.DAY_OF_YEAR, -1);

    return {
        start: calendar.getTime(),
        end: end,
        label: StringUtils.formatCalendar(calendar, 'yyyy-MM-dd')
    };
}

/**
 * Reads one field from an order as a string.
 *
 * @param {dw.order.Order} order - Order to read
 * @param {string} field - Field name from ALLOWED_FIELDS
 * @returns {string} Field value
 */
function getOrderFieldValue(order, field) {
    switch (field) {
        case 'creationDate':
            return StringUtils.formatCalendar(new Calendar(order.creationDate), "yyyy-MM-dd'T'HH:mm:ss");
        case 'totalGrossPrice':
            return order.totalGrossPrice.value.toFixed(2);
        case 'status':
            return order.status.displayValue;
        case 'channel':
            return order.channelType.displayValue;
        default:
            return String(order[field] || '');
    }
}

/**
 * Escapes a value for CSV output.
 *
 * @param {string} value - Raw value
 * @returns {string} Escaped value
 */
function escapeCsvField(value) {
    let str = String(value);

    if (str.indexOf(CSV_SEPARATOR) !== -1 || str.indexOf('"') !== -1 || str.indexOf('\n') !== -1) {
        str = '"' + str.replace(/"/g, '""') + '"';
    }

    return str;
}

// Filled by the processOrders callback; reset by buildCsv before each run.
let reportFields = [];
let rows = [];

/**
 * Query for the non-failed orders created in a date range. Placeholders:
 * {0} range start (inclusive), {1} range end (exclusive), {2} failed status.
 *
 * @returns {string} Query string for OrderMgr.processOrders
 */
function getOrderQuery() {
    return 'creationDate >= {0} AND creationDate < {1} AND status != {2}';
}

/**
 * OrderMgr.processOrders callback: collects one CSV row per order into the
 * module-level rows buffer using the configured report fields.
 *
 * @param {dw.order.Order} order - Order to collect
 */
function collectOrderRow(order) {
    let line = reportFields.map(function (field) {
        return escapeCsvField(getOrderFieldValue(order, field));
    }).join(CSV_SEPARATOR);

    rows.push({ createdAt: order.creationDate.getTime(), line: line });
}

/**
 * Builds a CSV string from all orders of the report day, sorted by creation
 * date (processOrders does not sort).
 *
 * @param {Date} start - Start of the day (inclusive)
 * @param {Date} end - End of the day (exclusive)
 * @param {string[]} fields - Fields to include
 * @returns {{content: string, rowCount: number}} CSV content and row count
 */
function buildCsv(start, end, fields) {
    reportFields = fields;
    rows = [];

    OrderMgr.processOrders(
        module.exports.collectOrderRow,
        module.exports.getOrderQuery(),
        start,
        end,
        Order.ORDER_STATUS_FAILED
    );

    rows.sort(function (a, b) {
        return a.createdAt - b.createdAt;
    });

    const lines = [fields.join(CSV_SEPARATOR)].concat(rows.map(function (row) {
        return row.line;
    }));

    return { content: lines.join('\n'), rowCount: rows.length };
}

/**
 * Sends the report as a mail attachment.
 *
 * @param {string[]} recipients - Recipient addresses
 * @param {string} sender - Sender address
 * @param {string} label - Report day label
 * @param {string} csv - CSV content
 * @returns {boolean} true when the mail was queued
 */
function sendReport(recipients, sender, label, csv) {
    const mail = new Mail();

    mail.addTo(recipients.join(','));
    mail.setFrom(sender);
    mail.setSubject('Daily sales report ' + label);
    mail.setContent('Daily sales report for ' + label + '\n\n' + csv, 'text/plain', 'UTF-8');

    return mail.send().status === Status.OK;
}

/**
 * Entry point for the DailySalesReport job step.
 *
 * @param {Object} params - Job step parameters
 * @returns {dw.system.Status} Step status
 */
function execute(params) {
    const recipients = (params.recipients || '').split(',').filter(Boolean);
    const fields = (params.fields || '').split(',').filter(function (field) {
        return ALLOWED_FIELDS.indexOf(field) !== -1;
    });

    if (recipients.length === 0) {
        Logger.error('DailySalesReport: no recipients configured.');

        return new Status(Status.ERROR);
    }

    if (fields.length === 0) {
        Logger.error('DailySalesReport: no valid fields configured.');

        return new Status(Status.ERROR);
    }

    const day = getReportDay();
    const csvResult = buildCsv(day.start, day.end, fields);

    Logger.info('DailySalesReport: collected ' + csvResult.rowCount + ' orders for ' + day.label);

    if (!sendReport(recipients, params.mailFrom, day.label, csvResult.content)) {
        Logger.error('DailySalesReport: sending the report for ' + day.label + ' failed.');

        return new Status(Status.ERROR);
    }

    return new Status(Status.OK);
}

module.exports = {
    execute: execute,
    buildCsv: buildCsv,
    collectOrderRow: collectOrderRow,
    getOrderQuery: getOrderQuery
};
