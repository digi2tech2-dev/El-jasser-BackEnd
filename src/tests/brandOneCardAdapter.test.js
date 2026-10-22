'use strict';

const axios = require('axios');
const { BrandOneCardAdapter } = require('../modules/providers/adapters/brandOneCard.adapter');
const { AlkasrVipAdapter } = require('../modules/providers/adapters/alkasr.adapter');
const { getAdapter, getProviderAdapter } = require('../modules/providers/adapters/adapter.factory');

const provider = { name: 'Brand One Card', slug: 'brand-one-card', baseUrl: 'https://api.brand-one-card.com/', apiToken: 'test-token' };
const makeAdapter = () => {
    const client = { get: jest.fn() };
    return { client, adapter: new BrandOneCardAdapter(provider, { httpClient: client }) };
};
const orderParams = { externalProductId: '365', quantity: 2, referenceId: 'KA-123', playerId: '5123456789', serverId: '42' };
const checkBody = (status = 'wait') => ({ status: 'OK', data: [{ order_id: '482913', order_uuid: 'KA-123', status, replay_api: ['Done'] }] });

describe('BrandOneCardAdapter', () => {
    afterEach(() => jest.restoreAllMocks());

    test('sets the root URL, api-token header and timeout', () => {
        const create = jest.spyOn(axios, 'create').mockReturnValue({ get: jest.fn() });
        new BrandOneCardAdapter(provider, { timeoutMs: 5000 });
        expect(create).toHaveBeenCalledWith(expect.objectContaining({
            baseURL: 'https://api.brand-one-card.com', timeout: 5000,
            headers: expect.objectContaining({ 'api-token': 'test-token' }),
        }));
        expect(() => new BrandOneCardAdapter({ baseUrl: provider.baseUrl })).toThrow(/token/);
        expect(() => new BrandOneCardAdapter({ apiToken: 'token' })).toThrow(/baseUrl/);
    });

    test('maps ranges, fixed quantity, availability, and preserves product metadata', async () => {
        const { adapter, client } = makeAdapter();
        const product = { id: 365, name: 'UC 60', price: 0.104, currency: 'USD', available: true,
            qty_values: { min: 1, max: 15000 }, product_type: 'amount', params: ['playerId'],
            params_info: [{ key: 'playerId', required: true }], category_name: 'PUBG' };
        client.get.mockResolvedValueOnce({ data: [product, { id: 366, name: 'Code', price: 5, available: false, qty_values: null, product_type: 'package' }] });
        expect(await adapter.fetchProducts()).toEqual([
            expect.objectContaining({ externalProductId: '365', rawPrice: '0.104', minQty: 1, maxQty: 15000, isActive: true, rawPayload: product }),
            expect.objectContaining({ externalProductId: '366', minQty: 1, maxQty: 1, isActive: false }),
        ]);
        expect(client.get).toHaveBeenCalledWith('/client/api/products');
    });

    test('rejects catalog errors and unsupported currencies instead of syncing a misleading catalog', async () => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValueOnce({ data: { status: 'ERROR', code: 121, msg: 'Token error' } });
        await expect(adapter.getProducts()).rejects.toThrow('Token error');
        client.get.mockResolvedValueOnce({ data: [{ id: 1, name: 'EGP', price: 10, currency: 'EGP' }] });
        await expect(adapter.getProducts()).rejects.toThrow('supports USD only');
        client.get.mockResolvedValueOnce({ data: {} });
        await expect(adapter.getProducts()).rejects.toThrow('Invalid product list');
    });

    test.each([['accept', 'Completed', true], ['wait', 'Pending', true], ['reject', 'Cancelled', false], ['unknown', 'Pending', true]])(
        'maps placement status %s without treating envelope OK as completion', async (status, providerStatus, success) => {
            const { adapter, client } = makeAdapter();
            client.get.mockResolvedValueOnce({ data: { status: 'OK', data: { order_id: '482913', status } } });
            await expect(adapter.placeOrder(orderParams)).resolves.toMatchObject({ success, providerOrderId: '482913', providerStatus });
            expect(client.get).toHaveBeenCalledWith('/client/api/newOrder/365/params', { params: {
                qty: 2, order_uuid: 'KA-123', playerId: '5123456789', serverId: '42',
            } });
        }
    );

    test('keeps the same reference across retries and strips internal financial fields', async () => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValue({ data: { status: 'OK', data: { order_id: '482913', status: 'wait' } } });
        await adapter.placeOrder({ ...orderParams, providerProductId: '365', price: 99, balance: 100, currency: 'USD' });
        await adapter.placeOrder(orderParams);
        expect(client.get.mock.calls[0]).toEqual(client.get.mock.calls[1]);
        expect(client.get.mock.calls[0][1].params).not.toHaveProperty('price');
    });

    test('allows products without player fields and accepts product/quantity aliases', async () => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValueOnce({ data: { status: 'OK', data: { order_id: 1, status: 'accept' } } });
        await expect(adapter.placeOrder({ productId: 366, amount: 1, order_uuid: 'stable-uuid' })).resolves.toMatchObject({ success: true });
        expect(client.get).toHaveBeenCalledWith('/client/api/newOrder/366/params', { params: { qty: 1, order_uuid: 'stable-uuid' } });
    });

    test.each([
        { quantity: 0 }, { quantity: 1.5 }, { referenceId: '' }, { externalProductId: 'bad' },
    ])('rejects invalid input before dispatch: %j', async (invalid) => {
        const { adapter, client } = makeAdapter();
        await expect(adapter.placeOrder({ ...orderParams, ...invalid })).resolves.toMatchObject({ success: false });
        expect(client.get).not.toHaveBeenCalled();
    });

    test.each([100, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 120, 121, 122, 123, 500])(
        'handles HTTP 200 API error %s without recovery or retry', async (code) => {
            const { adapter, client } = makeAdapter();
            const body = { status: 'ERROR', code, msg: 'Provider error', detail: 'extra detail' };
            client.get.mockResolvedValueOnce({ data: body });
            await expect(adapter.placeOrder(orderParams)).resolves.toMatchObject({ success: false, rawResponse: body, errorMessage: 'Provider error' });
            expect(client.get).toHaveBeenCalledTimes(1);
        }
    );

    test('recovers a timeout by UUID using the documented JSON array query', async () => {
        const { adapter, client } = makeAdapter();
        client.get.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }))
            .mockResolvedValueOnce({ data: checkBody('accept') });
        await expect(adapter.placeOrder(orderParams)).resolves.toMatchObject({ success: true, providerOrderId: '482913', providerStatus: 'Completed' });
        expect(client.get).toHaveBeenLastCalledWith('/client/api/check', { params: { uuid: 1, orders: '["KA-123"]' } });
    });

    test.each(['missing', 'lookup failure', 'malformed response'])('keeps uncertain placement funded on %s', async (scenario) => {
        const { adapter, client } = makeAdapter();
        if (scenario === 'malformed response') client.get.mockResolvedValueOnce({ data: { status: 'OK' } });
        else client.get.mockRejectedValueOnce(new Error('connection lost'));
        if (scenario === 'lookup failure') client.get.mockRejectedValueOnce(new Error('offline'));
        else client.get.mockResolvedValueOnce({ data: { status: 'OK', data: [] } });
        await expect(adapter.placeOrder(orderParams)).resolves.toMatchObject({ success: true, providerOrderId: null, providerStatus: 'PLACEMENT_UNCERTAIN' });
    });

    test('polls only matching IDs, maps statuses and retains delivered data', async () => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValueOnce({ data: { status: 'OK', data: [
            { order_id: 1, status: 'accept', replay_api: ['Code'] },
            { order_id: 2, status: 'reject' }, { order_id: 3, status: 'wait' }, { order_id: 999, status: 'accept' },
        ] } });
        expect(await adapter.checkOrdersBatch([1, 2, 3])).toEqual([
            expect.objectContaining({ providerOrderId: '1', providerStatus: 'Completed', rawResponse: expect.objectContaining({ replay_api: ['Code'] }) }),
            expect.objectContaining({ providerOrderId: '2', providerStatus: 'Cancelled' }),
            expect.objectContaining({ providerOrderId: '3', providerStatus: 'Pending' }),
        ]);
        expect(client.get).toHaveBeenCalledWith('/client/api/check', { params: { orders: '[1,2,3]' } });
        await expect(adapter.checkOrders([])).resolves.toEqual([]);
        client.get.mockResolvedValueOnce({ data: { status: 'OK', data: [] } });
        await expect(adapter.checkOrder(12)).resolves.toBeNull();
    });

    test('never turns check API errors into a final status', async () => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValueOnce({ data: { status: 'ERROR', code: 111, msg: 'Try again after 1 minute' } });
        await expect(adapter.checkOrder(1)).rejects.toThrow('Try again after 1 minute');
    });

    test('reads profile and categories and propagates API errors', async () => {
        const { adapter, client } = makeAdapter();
        const profile = { balance: '8788.68', currency: 'USD', email: 'user@example.com' };
        client.get.mockResolvedValueOnce({ data: profile });
        await expect(adapter.getMyInfo()).resolves.toEqual(profile);
        expect(client.get).toHaveBeenLastCalledWith('/client/api/profile');
        const content = { status: 'OK', categories: [{ id: 12, name: 'PUBG' }], products: [] };
        client.get.mockResolvedValueOnce({ data: content });
        await expect(adapter.getContent()).resolves.toEqual(content);
        expect(client.get).toHaveBeenLastCalledWith('/client/api/content/0');
        client.get.mockResolvedValueOnce({ data: { status: 'ERROR', msg: 'IP not allowed', code: 123 } });
        await expect(adapter.getBalance()).rejects.toThrow('IP not allowed');
    });

    test.each(['brand-one-card', 'brand one card', 'brandonecard'])('both factories resolve the new provider: %s', (key) => {
        for (const factory of [getAdapter, getProviderAdapter]) {
            for (const field of ['slug', 'name', 'adapterType']) {
                expect(factory({ baseUrl: provider.baseUrl, apiToken: 'token', [field]: key }, { strict: true, httpClient: {} }))
                    .toBeInstanceOf(BrandOneCardAdapter);
            }
        }
    });

    test.each(['brand1-card', 'brand1 card', 'brand1card'])('preserves the original provider: %s', (key) => {
        for (const factory of [getAdapter, getProviderAdapter]) {
            expect(factory({ ...provider, slug: key, name: key }, { strict: true })).toBeInstanceOf(AlkasrVipAdapter);
        }
    });
});
