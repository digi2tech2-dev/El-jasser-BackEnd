'use strict';

const { CanonicalB2BAdapter } = require('../modules/providers/adapters/canonicalB2B.adapter');

const provider = {
    name: 'Canonical upstream',
    adapterType: 'canonical-b2b',
    baseUrl: 'https://upstream.example/client/api/',
    apiToken: 'private-token',
};

const makeClient = (overrides = {}) => ({
    get: jest.fn(),
    post: jest.fn(),
    ...overrides,
});

describe('CanonicalB2BAdapter', () => {
    test('uses the configured full canonical base URL and api-token header', () => {
        const client = makeClient();
        const adapter = new CanonicalB2BAdapter(provider, { httpClient: client });
        expect(adapter._client).toBe(client);
    });

    test('maps products, retains fields in raw payload, and rejects non-USD products', async () => {
        const client = makeClient({
            get: jest.fn().mockResolvedValue({ data: [{
                id: 1001, name: 'Product', price: 4.5, available: true,
                qty_values: { min: '1', max: '5' }, fields: [{ key: 'player_id' }],
            }] }),
        });
        const adapter = new CanonicalB2BAdapter(provider, { httpClient: client });
        await expect(adapter.getProducts()).resolves.toEqual([expect.objectContaining({
            externalProductId: '1001', rawPrice: '4.5', minQty: 1, maxQty: 5,
            rawPayload: expect.objectContaining({ fields: [{ key: 'player_id' }] }),
        })]);

        client.get.mockResolvedValueOnce({ data: [{ id: 2, name: 'EGP', price: 1, currency: 'EGP' }] });
        await expect(adapter.getProducts()).rejects.toThrow('supports USD only');
    });

    test('places using the stable supplied reference and canonical payload', async () => {
        const client = makeClient({ post: jest.fn().mockResolvedValue({ data: { status: 'OK', data: { order_id: 'remote-1', status: 'wait' } } }) });
        const adapter = new CanonicalB2BAdapter(provider, { httpClient: client });
        await expect(adapter.placeOrder({ externalProductId: '1001', quantity: 2, referenceId: 'KA-REF-1', player_id: '55' }))
            .resolves.toMatchObject({ success: true, providerOrderId: 'remote-1', providerStatus: 'wait' });
        expect(client.post).toHaveBeenCalledWith('/orders', {
            product_id: 1001, qty: 2, order_uuid: 'KA-REF-1', params: { player_id: '55' },
        });
    });

    test('uses uuids lookup for reference recovery and preserves uncertainty on lost placement response', async () => {
        const timeout = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
        const client = makeClient({
            post: jest.fn().mockRejectedValue(timeout),
            get: jest.fn().mockResolvedValue({ data: { status: 'OK', data: [{ order_id: 'remote-2', order_uuid: 'KA-REF-2', status: 'wait' }] } }),
        });
        const adapter = new CanonicalB2BAdapter(provider, { httpClient: client });
        await expect(adapter.placeOrder({ externalProductId: '1001', quantity: 1, referenceId: 'KA-REF-2' }))
            .resolves.toMatchObject({ success: true, providerOrderId: 'remote-2' });
        expect(client.get).toHaveBeenCalledWith('/check', { params: { uuids: 'KA-REF-2' } });
    });
});
