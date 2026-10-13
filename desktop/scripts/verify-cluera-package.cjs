'use strict';
// The build tool requires hook entry points inside the desktop package.
// Verification remains shared first-party code in this same Cluera repository.
module.exports = context => require('../../scripts/verify-cluera-package.cjs')(context);
