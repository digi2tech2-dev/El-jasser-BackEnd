'use strict';

const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const { Product } = require('../modules/products/product.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { validateAdminProductUpdate, schemas } = require('../modules/admin/admin.validation');
const { updateProductValidation } = require('../modules/products/product.validation');
const { updateProduct } = require('../modules/products/product.service');

const query = (result) => ({
    select() { return this; },
    populate() { return this; },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
});

const setup = (slug = 'jasser-card') => {
    const provider = { _id: new mongoose.Types.ObjectId(), slug };
    const destination = {
        _id: new mongoose.Types.ObjectId(), provider, rawPrice: '0.104',
        minQty: 500000, maxQty: 99999999.9999,
    };
    const product = new Product({
        name: 'Existing product', basePrice: '10', minQty: 1, maxQty: 100,
        provider: new mongoose.Types.ObjectId(), providerProduct: new mongoose.Types.ObjectId(),
        pricingMode: 'sync', markupType: 'percentage', markupValue: 0,
    });
    jest.spyOn(Product, 'findById').mockImplementation(() => query(product));
    jest.spyOn(ProviderProduct, 'findById').mockImplementation(() => query(destination));
    jest.spyOn(product, 'save').mockImplementation(async () => { await product.validate(); return product; });
    jest.spyOn(product, 'populate').mockResolvedValue(product);
    const req = {
        params: { id: String(product._id) },
        body: {
            providerProduct: String(destination._id), provider: String(provider._id),
            minQty: destination.minQty, maxQty: destination.maxQty,
        },
    };
    return { req, product, destination };
};

beforeEach(() => {
    jest.spyOn(mongoose, 'connect').mockImplementation(() => { throw new Error('No database allowed'); });
});
afterEach(() => jest.restoreAllMocks());

const validate = async (api, req) => {
    if (api === 'admin') {
        const next = jest.fn();
        await validateAdminProductUpdate(req, {}, next);
        return next.mock.calls[0]?.[0];
    }
    for (const middleware of updateProductValidation) await middleware.run(req);
    return validationResult(req).isEmpty() ? undefined : validationResult(req).array();
};

test('reproduces the original admin rejection of the real Jasser catalog maximum', () => {
    const { req } = setup();
    expect(schemas.updateAdminProduct.validate(req.body).error.details)
        .toEqual(expect.arrayContaining([expect.objectContaining({ path: ['maxQty'], type: 'number.integer' })]));
});

describe.each(['admin', 'products'])('%s product update API', (api) => {
    test.each([99999999.9999, '99999999.9999'])('relinks an existing product to Jasser and saves maximum %s unchanged', async (max) => {
        const { req, product, destination } = setup();
        req.body.maxQty = max;
        expect(await validate(api, req)).toBeUndefined();
        await updateProduct(req.params.id, req.body);
        expect(product.save).toHaveBeenCalledTimes(1);
        expect(String(product.providerProduct)).toBe(String(destination._id));
        expect(String(product.provider)).toBe(String(destination.provider._id));
        expect(product.maxQty).toBe(99999999.9999);
        expect(product.minQty).toBe(500000);
        expect(product.providerPrice).toBe('0.104');
        expect(mongoose.connect).not.toHaveBeenCalled();
    });

    test('allows editing an already linked Jasser product without resending its link', async () => {
        const { req, product, destination } = setup();
        product.providerProduct = destination._id;
        req.body = { maxQty: destination.maxQty };
        expect(await validate(api, req)).toBeUndefined();
        await updateProduct(req.params.id, req.body);
        expect(product.maxQty).toBe(destination.maxQty);
    });

    test('keeps integer-only validation for another provider even with a claimed Jasser provider ID', async () => {
        const { req } = setup('mock');
        req.body.provider = String(new mongoose.Types.ObjectId());
        expect(await validate(api, req)).toBeDefined();
    });

    test('keeps ordinary integer relinking unchanged and avoids extra catalog reads', async () => {
        const { req } = setup('mock');
        req.body.maxQty = 1000000;
        expect(await validate(api, req)).toBeUndefined();
        expect(ProviderProduct.findById).not.toHaveBeenCalled();
        await updateProduct(req.params.id, req.body);
    });

    test.each([true, '', null, 0, -1, Infinity, 'NaN', 1.25])('rejects invalid or inverted maximum %s', async (max) => {
        const { req } = setup();
        req.body.maxQty = max;
        expect(await validate(api, req)).toBeDefined();
    });

    test('does not allow a fractional maximum when the provider link is removed', async () => {
        const { req } = setup();
        req.body.providerProduct = null;
        expect(await validate(api, req)).toBeDefined();
    });

    test('rejects a missing destination product', async () => {
        const { req } = setup();
        ProviderProduct.findById.mockImplementation(() => query(null));
        expect(await validate(api, req)).toBeDefined();
    });
});
