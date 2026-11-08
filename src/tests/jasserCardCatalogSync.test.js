'use strict';

// Real adapter/factory/sync engine, entirely mocked HTTP and persistence.
const mongoose = require('mongoose');
const axios = require('axios');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product } = require('../modules/products/product.model');
const { syncProviderProducts, isSyncRunning } = require('../modules/providers/providerProductSync.service');

beforeEach(() => {
    jest.spyOn(mongoose, 'connect').mockImplementation(() => { throw new Error('No database allowed'); });
    jest.spyOn(mongoose.connection, 'openUri').mockImplementation(() => { throw new Error('No database allowed'); });
});
afterEach(() => {
    expect(mongoose.connect).not.toHaveBeenCalled();
    expect(mongoose.connection.openUri).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});

const setup = (slug = 'jasser-card') => {
    const provider = { _id: new mongoose.Types.ObjectId(), slug, baseUrl: 'https://provider.invalid', apiToken: 'fake-token', isActive: true };
    const rawId = new mongoose.Types.ObjectId();
    const publishedId = new mongoose.Types.ObjectId();
    const client = { get: jest.fn(), interceptors: { response: { use: jest.fn() } } };
    jest.spyOn(axios, 'create').mockReturnValue(client);
    const product = { id: 99, name: 'Synthetic catalog fixture', price: '5', qty_values: { min: '2', max: '1594.75' } };
    let stored;
    jest.spyOn(Provider, 'findById').mockResolvedValue(provider);
    const upsert = jest.spyOn(ProviderProduct, 'findOneAndUpdate').mockImplementation(async (filter, update) => {
        stored = { _id: rawId, ...filter, ...update.$set, createdAt: new Date(), updatedAt: new Date() };
        return stored;
    });
    const deactivate = jest.spyOn(ProviderProduct, 'updateMany').mockResolvedValue({ modifiedCount: 0 });
    jest.spyOn(ProviderProduct, 'findById').mockImplementation(() => ({ select: async () => stored }));
    jest.spyOn(Product, 'find').mockReturnValue({ select: async () => [{ _id: publishedId, markupType: 'percentage', markupValue: '0' }] });
    const updatePublished = jest.spyOn(Product, 'findByIdAndUpdate').mockResolvedValue({});
    client.get.mockResolvedValue({ data: [product] });
    return { provider, client, product, rawId, publishedId, upsert, deactivate, updatePublished };
};

test('Jasser sync carries decimal max from HTTP through raw and published products without rounding', async () => {
    const { provider, client, upsert, deactivate, updatePublished, publishedId } = setup();
    const result = await syncProviderProducts(provider._id, { httpClient: client });
    expect(result).toMatchObject({ totalFetched: 1, pricesSynced: 1, errors: [] });
    expect(upsert).toHaveBeenCalledWith(
        { provider: provider._id, externalProductId: '99' },
        { $set: expect.objectContaining({ minQty: 2, maxQty: 1594.75, rawPayload: expect.objectContaining({ qty_values: { min: '2', max: '1594.75' } }) }) },
        expect.objectContaining({ upsert: true })
    );
    expect(updatePublished).toHaveBeenCalledWith(publishedId, { $set: expect.objectContaining({ minQty: 2, maxQty: 1594.75 }) });
    expect(deactivate).not.toHaveBeenCalled();
    expect(isSyncRunning(provider._id)).toBe(false);
});

test('actual product 1594 retains its numeric range through raw and published catalog sync', async () => {
    const { provider, client, upsert, updatePublished, publishedId, deactivate } = setup();
    const actual = { id: 1594, name: 'Halo Star هالو ستار', product_type: 'range', price: '5', qty_values: { min: 500000, max: 99999999.9999 } };
    client.get.mockResolvedValue({ data: [actual] });
    await expect(syncProviderProducts(provider._id, { httpClient: client })).resolves.toMatchObject({ totalFetched: 1, pricesSynced: 1, errors: [] });
    expect(upsert.mock.calls[0][1].$set).toMatchObject({ minQty: 500000, maxQty: 99999999.9999, rawPayload: actual });
    expect(updatePublished).toHaveBeenCalledWith(publishedId, { $set: expect.objectContaining({ minQty: 500000, maxQty: 99999999.9999 }) });
    // The response omits 1537. No mass deactivation is allowed for Jasser.
    expect(deactivate).not.toHaveBeenCalled();
});

test.each([
    { min: 1.5, max: 100 }, [], { min: 1, max: 'unknown' }, { min: 1 },
])('invalid Jasser product fails the entire fetch before any write or deactivation: %j', async (rules) => {
    const { provider, client, product, upsert, deactivate, updatePublished } = setup();
    client.get.mockResolvedValue({ data: [product, { ...product, id: 100, qty_values: rules }] });
    await expect(syncProviderProducts(provider._id, { httpClient: client })).rejects.toThrow('Invalid quantity rules for product 100');
    expect(upsert).not.toHaveBeenCalled();
    expect(deactivate).not.toHaveBeenCalled();
    expect(updatePublished).not.toHaveBeenCalled();
    expect(isSyncRunning(provider._id)).toBe(false);
});

test('a failed Jasser upsert prevents deactivation and publication of an incomplete catalog', async () => {
    const { provider, client, product, upsert, deactivate, updatePublished } = setup();
    client.get.mockResolvedValue({ data: [product, { ...product, id: 100 }] });
    upsert.mockRejectedValueOnce(new Error('simulated write failure'));
    await expect(syncProviderProducts(provider._id, { httpClient: client })).rejects.toMatchObject({ code: 'PROVIDER_CATALOG_SYNC_INCOMPLETE' });
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(deactivate).not.toHaveBeenCalled();
    expect(updatePublished).not.toHaveBeenCalled();
    expect(isSyncRunning(provider._id)).toBe(false);
});

test('Jasser empty catalog does not deactivate existing products', async () => {
    const { provider, client, deactivate } = setup();
    client.get.mockResolvedValue({ data: [] });
    await expect(syncProviderProducts(provider._id, { httpClient: client })).resolves.toMatchObject({ totalFetched: 0 });
    expect(deactivate).not.toHaveBeenCalled();
});

test('legacy supplier keeps its integer-only published bounds behavior', async () => {
    const { provider, client, product, updatePublished } = setup('alkasr');
    // Alkasr's existing adapter truncates its raw quantity range; this is left
    // untouched. A fractional saved max must still be excluded by the old path.
    client.get.mockResolvedValue({ data: [product] });
    jest.spyOn(ProviderProduct, 'findById').mockReturnValue({ select: async () => ({ rawName: product.name, minQty: 2, maxQty: 1594.75 }) });
    await syncProviderProducts(provider._id, { httpClient: client });
    expect(updatePublished).toHaveBeenCalled();
    expect(updatePublished.mock.calls[0][1].$set).not.toHaveProperty('maxQty');
    expect(updatePublished.mock.calls[0][1].$set).not.toHaveProperty('minQty');
});

test('legacy supplier retains its existing partial-upsert handling', async () => {
    const { provider, client, product, upsert, deactivate } = setup('alkasr');
    client.get.mockResolvedValue({ data: [product] });
    upsert.mockRejectedValueOnce(new Error('simulated legacy write failure'));
    const result = await syncProviderProducts(provider._id, { httpClient: client });
    expect(result.errors).toEqual([expect.stringContaining('simulated legacy write failure')]);
    expect(deactivate).toHaveBeenCalled();
});
