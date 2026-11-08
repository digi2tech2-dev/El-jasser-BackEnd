'use strict';

const mongoose = require('mongoose');

const userProductOverrideSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    // A final USD unit price. Null means use the user's group pricing.
    priceOverride: { type: String, default: null, trim: true },
    isHidden: { type: Boolean, default: false },
    isHiddenFromApi: { type: Boolean, default: false },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

userProductOverrideSchema.index({ userId: 1, productId: 1 }, { unique: true });

const UserProductOverride = mongoose.models.UserProductOverride
    || mongoose.model('UserProductOverride', userProductOverrideSchema);

module.exports = { UserProductOverride };
