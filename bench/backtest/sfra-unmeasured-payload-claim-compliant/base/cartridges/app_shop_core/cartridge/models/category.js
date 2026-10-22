'use strict';

function CategoryModel(category) {
    this.id = category.ID;
    this.name = category.displayName;
}

module.exports = CategoryModel;
