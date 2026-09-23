'use strict';

/**
 * @module scripts/jobs/returns/CloseStaleReturns
 * @description Job step that reads CSV files of return authorisation numbers
 * from the impex folder, closes each open return and archives the file.
 */

const File = require('dw/io/File');
const FileReader = require('dw/io/FileReader');
const CSVStreamReader = require('dw/io/CSVStreamReader');
const OrderMgr = require('dw/order/OrderMgr');
const Status = require('dw/system/Status');
const Transaction = require('dw/system/Transaction');
const logger = require('dw/system/Logger').getLogger('job', 'job.returns.close');

/**
 * Closes the open return case of an order.
 *
 * @param {dw.order.Order} order - order owning the return case
 * @param {string} rmaNumber - return authorisation number
 * @returns {boolean} true when the case was closed or already closed
 */
function closeReturnCase(order, rmaNumber) {
    const returnCase = order.getReturnCase(rmaNumber);

    if (!returnCase) {
        logger.warn('Return {0} not found on order {1}', rmaNumber, order.orderNo);

        return false;
    }

    if (returnCase.status.value === 'CONFIRMED') {
        return true;
    }

    try {
        Transaction.wrap(function () {
            returnCase.confirm();
        });

        return true;
    } catch (e) {
        logger.error('Closing return {0} failed: {1}', rmaNumber, e.message);

        return false;
    }
}

/**
 * Processes one CSV stream: each row holds an order number and an RMA number.
 *
 * @param {dw.io.Reader} inputStream - reader over the CSV file
 * @returns {boolean} true when every row was processed
 */
function processInput(inputStream) {
    const streamReader = new CSVStreamReader(inputStream, ',', '"');
    let allClosed = true;
    let line;

    while ((line = streamReader.readNext()) !== null) {
        let orderNumber = (line[0] || '').trim();
        let rmaNumber = (line[1] || '').trim();

        if (!orderNumber || !rmaNumber) {
            continue;
        }

        let order = OrderMgr.getOrder(orderNumber);

        if (order === null) {
            logger.warn('Order "{0}" not found', orderNumber);
            allClosed = false;
            continue;
        }

        if (!closeReturnCase(order, rmaNumber)) {
            allClosed = false;
        }
    }

    streamReader.close();

    return allClosed;
}

/**
 * Job entry point.
 *
 * @returns {dw.system.Status} OK, or ERROR when a row could not be processed
 */
function execute() {
    const params = arguments[0];
    const folder = new File(File.IMPEX + File.SEPARATOR + 'src' + File.SEPARATOR + params.sourceFolder);
    const archiveDirectory = new File(folder.getFullPath() + File.SEPARATOR + 'archive');
    let success = true;

    if (!folder.exists()) {
        logger.info('Source folder {0} does not exist, nothing to do', folder.getFullPath());

        return new Status(Status.OK);
    }

    archiveDirectory.mkdirs();

    const filePaths = folder.listFiles(function (file) {
        return file.isFile() && file.getName().endsWith('.csv');
    });

    for (let i = 0; i < filePaths.getLength(); i++) {
        let inputFile = filePaths[i];

        logger.info('Started processing of {0}', inputFile.getFullPath());

        let fileReader = new FileReader(inputFile, 'UTF-8');

        if (!processInput(fileReader)) {
            success = false;
        }

        fileReader.close();

        let archiveFile = new File(archiveDirectory, inputFile.getName());

        inputFile.renameTo(archiveFile);

        logger.info('Archived {0}', archiveFile.getFullPath());
    }

    return new Status(success ? Status.OK : Status.ERROR);
}

module.exports = {
    execute: execute
};
