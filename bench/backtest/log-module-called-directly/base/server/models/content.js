'use strict';

var ContentStore = require('app/content/ContentStore');

/**
 * The content asset behind an id, as a plain object.
 * @param {string} id the content asset id
 * @returns {Object|null} the asset, or null when no asset has that id
 */
function content(id) {
    var asset = ContentStore.get(id);
    if (!asset) {
        return null;
    }
    return { id: asset.id, body: asset.body };
}

module.exports = content;
