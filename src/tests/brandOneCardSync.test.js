'use strict';

// Real adapter, factory, currency conversion and sync service; mocked I/O.
const axios = require('axios');
const mongoose = require('mongoose');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Currency } = require('../modules/currency/currency.model');
const { Product } = require('../modules/products/product.model');
const { syncProviderProducts, isSyncRunning } = require('../modules/providers/providerProductSync.service');
const { getProviderLiveProducts } = require('../modules/admin/admin.providers.service');
const { invalidateCurrencyCache } = require('../services/currencyConverter.service');

beforeEach(() => invalidateCurrencyCache('EGP'));
afterEach(() => {
    jest.restoreAllMocks();
    invalidateCurrencyCache('EGP');
});

const setup = () => {
    const provider = { _id: new mongoose.Types.ObjectId(), name: 'Brand One Card', slug: 'brand-one-card', baseUrl: 'https://api.brand-one-card.com', apiToken: 'test-token', isActive: true };
    const product = { id: 7, name: 'UC 60', price: '52', currency: 'EGP', available: true, qty_values: null, params: ['playerId'] };
    const client = { get: jest.fn().mockResolvedValue({ data: [product] }) };
    jest.spyOn(Provider, 'findById').mockResolvedValue(provider);
    const currencyQuery = jest.spyOn(Currency, 'findOne').mockResolvedValue({ code: 'EGP', platformRate: 50, marketRate: 49, isActive: true });
    const upsert = jest.spyOn(ProviderProduct, 'findOneAndUpdate').mockResolvedValue({ _id: new mongoose.Types.ObjectId(), createdAt: new Date(), updatedAt: new Date() });
    const deactivate = jest.spyOn(ProviderProduct, 'updateMany').mockResolvedValue({ modifiedCount: 0 });
    jest.spyOn(Product, 'find').mockReturnValue({ select: jest.fn().mockResolvedValue([{ _id: new mongoose.Types.ObjectId(), markupType: 'percentage', markupValue: '10' }]) });
    const updatePublished = jest.spyOn(Product, 'findByIdAndUpdate').mockResolvedValue({});
    return { provider, product, client, currencyQuery, upsert, deactivate, updatePublished };
};

test('syncs EGP into USD and propagates USD prices with markup to published products', async () => {
    const { provider, client, upsert, updatePublished } = setup();
    const result = await syncProviderProducts(provider._id, { httpClient: client });
    expect(result).toMatchObject({ totalFetched: 1, pricesSynced: 1, errors: [] });
    expect(upsert).toHaveBeenCalledWith(
        { provider: provider._id, externalProductId: '7' },
        { $set: expect.objectContaining({ rawPrice: '1.04', minQty: 1, maxQty: 1, rawPayload: expect.objectContaining({ price: '52', currency: 'EGP', params: ['playerId'] }) }) },
        expect.objectContaining({ upsert: true })
    );
    expect(updatePublished).toHaveBeenCalledWith(expect.anything(), {
        $set: { providerPrice: '1.04', finalPrice: '1.144', basePrice: '1.144' },
    });
});

test('admin live product view uses the same EGP conversion through the factory', async () => {
    const { provider, client } = setup();
    jest.spyOn(axios, 'create').mockReturnValue(client);
    await expect(getProviderLiveProducts(provider._id)).resolves.toMatchObject({
        provider: 'Brand One Card', count: 1, products: [expect.objectContaining({ rawPrice: '1.04' })],
    });
});

test('a platform rate update changes the next sync without changing provider prices', async () => {
    const { provider, client, currencyQuery, upsert } = setup();
    await syncProviderProducts(provider._id, { httpClient: client });
    currencyQuery.mockResolvedValue({ code: 'EGP', platformRate: 52, isActive: true });
    invalidateCurrencyCache('EGP');
    await syncProviderProducts(provider._id, { httpClient: client });
    expect(upsert.mock.calls[1][1].$set.rawPrice).toBe('1');
    expect(upsert.mock.calls[1][1].$set.rawPayload.price).toBe('52');
});

test('a missing rate prevents writes and deactivation and releases the sync lock', async () => {
    const { provider, client, currencyQuery, upsert, deactivate, updatePublished } = setup();
    currencyQuery.mockResolvedValue(null);
    await expect(syncProviderProducts(provider._id, { httpClient: client })).rejects.toMatchObject({ statusCode: 422, code: 'PROVIDER_CURRENCY_RATE_UNAVAILABLE' });
    expect(upsert).not.toHaveBeenCalled();
    expect(deactivate).not.toHaveBeenCalled();
    expect(updatePublished).not.toHaveBeenCalled();
    expect(isSyncRunning(provider._id)).toBe(false);
});
