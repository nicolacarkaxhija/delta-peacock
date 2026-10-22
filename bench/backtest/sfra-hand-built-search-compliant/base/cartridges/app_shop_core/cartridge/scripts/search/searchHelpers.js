'use strict';

var ProductSearchModel = require('dw/catalog/ProductSearchModel');

/** Builds the search the category listing runs: storefront visibility and search exclusions applied. */
function createVisibleSearch(categoryId) {
    var search = new ProductSearchModel();
    search.setCategoryID(categoryId);
    search.addRefinementValues('hideOnStorefront', 'false');
    search.setOrderableProductsOnly(true);
    search.search();
    return search;
}

module.exports = { createVisibleSearch: createVisibleSearch };
