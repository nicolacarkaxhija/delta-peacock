'use strict';

/**
 * @memberof gallery_legacy
 * @module Thumbnail
 * @description Builds thumbnail descriptors for the photo gallery.
 */

var WIDTH = 240;

/**
 * @memberof gallery_legacy
 * @class Thumbnail
 * @classdesc A thumbnail of one picture at the gallery width.
 * @param {Object} picture the picture with its url and title
 */
function Thumbnail(picture) {
    this.url = picture.url + '?w=' + WIDTH;
    this.width = WIDTH;
    this.alt = picture.title || '';
    return this;
}

module.exports = Thumbnail;
