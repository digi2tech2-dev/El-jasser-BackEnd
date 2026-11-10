'use strict';

const mongoose = require('mongoose');
const { Product } = require('./product.model');
const { ProviderProduct } = require('../providers/providerProduct.model');
const { isJasserCardProvider } = require('../providers/adapters/adapter.factory');

// Only Jasser's catalog maximum may be fractional. Resolve the destination
// from persisted ProviderProduct data, never the provider ID supplied by a client.
const allowsJasserDecimalMaximum = async (req) => {
    const max = req.body?.maxQty;
    if ((typeof max !== 'number' && typeof max !== 'string')
        || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(String(max).trim())
        || !Number.isFinite(Number(max)) || Number(max) < 1
        || Number.isInteger(Number(max))) return false;

    const body = req.body;
    let current;
    if (body.providerProduct === undefined || body.minQty === undefined) {
        if (!mongoose.isObjectIdOrHexString(req.params?.id)) return false;
        current = await Product.findById(req.params.id).select('providerProduct minQty');
        if (!current) return false;
    }
    const linkedId = body.providerProduct === undefined ? current?.providerProduct : body.providerProduct;
    if (!mongoose.isObjectIdOrHexString(linkedId)) return false;
    const linked = await ProviderProduct.findById(linkedId)
        .select('provider').populate('provider', 'adapterType slug name');
    if (!linked || !isJasserCardProvider(linked.provider)) return false;

    const min = Number(body.minQty ?? current?.minQty);
    return Number.isSafeInteger(min) && min >= 1 && Number(max) >= min;
};

module.exports = { allowsJasserDecimalMaximum };
