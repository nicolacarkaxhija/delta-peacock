'use strict';

function CategoriesModel(items) {
    this.categories = items.map(function (c) { return { id: c.ID, name: c.displayName }; });
}

module.exports = CategoriesModel;
