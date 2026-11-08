'use strict';

const http = require('http');
const axios = require('axios');
const { JasserCardAdapter } = require('../modules/providers/adapters/jasserCard.adapter');
const { getAdapter, getProviderAdapter } = require('../modules/providers/adapters/adapter.factory');
const { AlkasrVipAdapter } = require('../modules/providers/adapters/alkasr.adapter');
const { BrandOneCardAdapter } = require('../modules/providers/adapters/brandOneCard.adapter');
const { AlmotasimCardAdapter } = require('../modules/providers/adapters/almotasimCard.adapter');

const provider = { baseUrl: 'https://www.jasser-card.net/', apiToken: 'private-test-token', slug: 'jasser-card' };
const params = { externalProductId: '365', quantity: 2, referenceId: 'KA-20261107-123', playerId: '123', serverId: '42' };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const body = (status = 'accept') => ({ status, order: { id: 'ID_a37aaa06', status, code: 'DELIVERED_CODE' }, message: '' });
const makeAdapter = () => {
    const client = { get: jest.fn() };
    return { client, adapter: new JasserCardAdapter(provider, { httpClient: client }) };
};

describe('Jasser Card adapter', () => {
    test.each(['http://www.jasser-card.net', 'https://user:pass@www.jasser-card.net', 'https://www.jasser-card.net?token=secret'])('rejects unsafe base URLs: %s', (baseUrl) => {
        expect(() => new JasserCardAdapter({ ...provider, baseUrl })).toThrow('HTTPS');
    });

    test.each([114, 500])('recovers ambiguous API error %s without a second purchase', async (code) => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValueOnce({ data: { code, message: 'Unknown error' } })
            .mockResolvedValueOnce({ data: { orders: [body().order] } });
        await expect(adapter.placeOrder(params)).resolves.toMatchObject({ success: true, providerStatus: 'Completed' });
        expect(client.get.mock.calls.map(([url]) => url)).toEqual(['/client/api/newOrder/365/params', '/client/api/check']);
    });

    test('uses a separate UUID namespace from the existing provider', async () => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValue({ data: body() });
        await adapter.placeOrder(params);
        const otherClient = { get: jest.fn().mockResolvedValue({ data: body() }) };
        await new AlmotasimCardAdapter(provider, { httpClient: otherClient }).placeOrder(params);
        expect(client.get.mock.calls[0][1].params.order_uuid).not.toBe(otherClient.get.mock.calls[0][1].params.order_uuid);
    });
    test('requires credentials and configures the documented header', () => {
        expect(() => new JasserCardAdapter({ baseUrl: provider.baseUrl })).toThrow('api token');
        expect(() => new JasserCardAdapter({ apiToken: 'token' })).toThrow('baseUrl');
        const spy = jest.spyOn(axios, 'create');
        try {
            new JasserCardAdapter({ baseUrl: provider.baseUrl, apiKey: 'legacy' }, { timeoutMs: 1250 });
            expect(spy).toHaveBeenCalledWith({ baseURL: 'https://www.jasser-card.net', timeout: 1250, maxRedirects: 0, headers: { 'api-token': 'legacy', Accept: 'application/json' } });
        } finally { spy.mockRestore(); }
    });

    test('maps all three quantity rule formats and keeps product metadata', async () => {
        const { adapter, client } = makeAdapter();
        const products = [
            { id: 1, name: 'UC', price: '0.104', qty_values: { min: '1', max: '15000' }, params: ['ادخل الايدي الاعب'], product_type: 'amount', available: true },
            { id: 2, name: 'Code', price: 5, qty_values: null, available: false },
            { id: 3, name: 'Choices', price: '0.000001', qty_values: ['210', '110', '150'] },
        ];
        client.get.mockResolvedValueOnce({ data: products });
        expect(await adapter.fetchProducts()).toEqual([
            expect.objectContaining({ externalProductId: '1', rawPrice: '0.104', minQty: 1, maxQty: 15000, rawPayload: products[0], isActive: true }),
            expect.objectContaining({ minQty: 1, maxQty: 1, isActive: false }),
            expect.objectContaining({ minQty: 110, maxQty: 210, rawPrice: '0.000001', rawPayload: products[2] }),
        ]);
    });

    test.each([[], ['x'], { min: 5, max: 1 }])('rejects invalid quantity rules %j', async (rules) => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValue({ data: [{ id: 1, name: 'Bad', price: 1, qty_values: rules }] });
        await expect(adapter.getProducts()).rejects.toThrow('quantity rules');
    });

    test.each([['accept', true, 'Completed'], ['wait', true, 'Pending'], ['reject', false, 'Cancelled'], ['unexpected', true, 'Pending']])(
        'maps placement %s safely', async (status, success, providerStatus) => {
            const { adapter, client } = makeAdapter();
            client.get.mockResolvedValue({ data: body(status) });
            await expect(adapter.placeOrder(params)).resolves.toMatchObject({ success, providerOrderId: 'ID_a37aaa06', providerStatus, rawResponse: body(status) });
        }
    );

    test('uses the same UUID across adapter instances, retries and reference recovery', async () => {
        const first = makeAdapter();
        first.client.get.mockResolvedValue({ data: body() });
        await first.adapter.placeOrder({ ...params, balance: 100, price: 1, currency: 'USD' });
        const query = first.client.get.mock.calls[0][1].params;
        expect(query).toEqual({ qty: 2, playerId: '123', serverId: '42', order_uuid: expect.stringMatching(uuidPattern) });
        const second = makeAdapter();
        second.client.get.mockResolvedValueOnce({ data: body() }).mockResolvedValueOnce({ data: { orders: [body().order] } });
        await second.adapter.placeOrder(params);
        expect(second.client.get.mock.calls[0][1].params.order_uuid).toBe(query.order_uuid);
        await expect(second.adapter.checkOrderByReference(params.referenceId)).resolves.toMatchObject({ found: true, providerOrderId: 'ID_a37aaa06' });
        expect(second.client.get).toHaveBeenLastCalledWith('/client/api/check', { params: { orders: JSON.stringify([query.order_uuid]), uuid: 1 } });
    });

    test('preserves explicit UUIDs and supports target aliases and code-only products', async () => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValue({ data: body() });
        const uuid = 'ecbdd545-e616-4aee-8770-7eefa977bcdd';
        await adapter.placeOrder({ providerProductId: 364, amount: 1, order_uuid: uuid, uid: '456' });
        expect(client.get).toHaveBeenLastCalledWith('/client/api/newOrder/364/params', { params: { qty: 1, order_uuid: uuid, uid: '456', playerId: '456' } });
        await adapter.placeOrder({ productId: 364, quantity: 1, referenceId: 'code-order' });
        expect(client.get.mock.calls[1][1].params).not.toHaveProperty('playerId');
    });

    test.each([{ quantity: 0 }, { quantity: 1.5 }, { externalProductId: '../bad' }, { referenceId: '' }, { order_uuid: 'bad' }])(
        'does not dispatch invalid input %j', async (invalid) => {
            const { adapter, client } = makeAdapter();
            await expect(adapter.placeOrder({ ...params, ...invalid })).resolves.toMatchObject({ success: false });
            expect(client.get).not.toHaveBeenCalled();
        }
    );

    test.each([100, 105, 106, 107, 108, 109, 110, 111, 112, 113, 120, 121, 122, 123, 130])(
        'handles documented error %s without placing again', async (code) => {
            const { adapter, client } = makeAdapter();
            client.get.mockResolvedValue({ data: { code, message: 'Provider rejected' } });
            await expect(adapter.placeOrder(params)).resolves.toMatchObject({ success: false, errorMessage: 'Provider rejected' });
            expect(client.get).toHaveBeenCalledTimes(1);
        }
    );

    test.each(['accept', 'wait', 'reject'])('recovers a lost response by UUID (%s)', async (status) => {
        const { adapter, client } = makeAdapter();
        client.get.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({ data: { orders: [body(status).order] } });
        await expect(adapter.placeOrder(params)).resolves.toMatchObject({ success: true, providerOrderId: 'ID_a37aaa06', providerStatus: status === 'accept' ? 'Completed' : status === 'reject' ? 'Cancelled' : 'Pending' });
        expect(client.get).toHaveBeenCalledTimes(2);
        expect(client.get.mock.calls[1][0]).toBe('/client/api/check');
    });

    test.each(['empty lookup', 'lookup failure', 'malformed placement'])('keeps uncertain placements for recovery: %s', async (scenario) => {
        const { adapter, client } = makeAdapter();
        if (scenario === 'malformed placement') client.get.mockResolvedValueOnce({ data: '<html>gateway</html>' });
        else client.get.mockRejectedValueOnce(new Error('connection reset'));
        if (scenario === 'lookup failure') client.get.mockRejectedValueOnce(new Error('offline'));
        else client.get.mockResolvedValueOnce({ data: { orders: [] } });
        await expect(adapter.placeOrder(params)).resolves.toMatchObject({ success: true, providerOrderId: null, providerStatus: 'PLACEMENT_UNCERTAIN' });
    });

    test('polls matching IDs, preserves codes, and never fails an unknown status', async () => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValueOnce({ data: { orders: [
            body().order, { id: '2', status: 'reject' }, { id: '3', status: 'wait' },
            { id: '4', status: 'new-status' }, { id: 'unrelated', status: 'accept' },
        ] } });
        const results = await adapter.checkOrdersBatch(['ID_a37aaa06', '2', '3', '4']);
        expect(results.map((result) => result.providerStatus)).toEqual(['Completed', 'Cancelled', 'Pending', 'Pending']);
        expect(results[0].rawResponse.code).toBe('DELIVERED_CODE');
        expect(client.get).toHaveBeenCalledWith('/client/api/check', { params: { orders: '["ID_a37aaa06","2","3","4"]' } });
        await expect(adapter.checkOrders([])).resolves.toEqual([]);
        client.get.mockResolvedValueOnce({ data: { orders: [] } });
        await expect(adapter.checkOrder('missing')).resolves.toBeNull();
    });

    test.each([{ code: 123, message: 'IP not allowed' }, {}, { orders: null }])('throws on invalid polling responses %j', async (data) => {
        const { adapter, client } = makeAdapter();
        client.get.mockResolvedValue({ data });
        await expect(adapter.checkOrder('1')).rejects.toThrow();
    });

    test('reads the documented profile and content', async () => {
        const { adapter, client } = makeAdapter();
        const profile = { balance: '8788.683', email: 'user@email.com', name: 'Customer', client_id: 'CL-ABC123' };
        client.get.mockResolvedValueOnce({ data: profile });
        await expect(adapter.getMyInfo()).resolves.toEqual(profile);
        expect(client.get).toHaveBeenLastCalledWith('/client/api/profile');
        client.get.mockResolvedValueOnce({ data: { products: [], categories: [] } });
        await adapter.getContent(12);
        expect(client.get).toHaveBeenLastCalledWith('/client/api/content/12');
    });

    test.each(['jasser-card', 'jasser card', 'jassercard', 'جاسر كارد'])('resolves both factories by slug/name/adapterType: %s', (key) => {
        for (const factory of [getAdapter, getProviderAdapter]) {
            for (const field of ['slug', 'name', 'adapterType']) {
                expect(factory({ baseUrl: provider.baseUrl, apiToken: 'token', [field]: key }, { httpClient: {} })).toBeInstanceOf(JasserCardAdapter);
            }
        }
    });

    test('preserves existing provider registrations', () => {
        for (const factory of [getAdapter, getProviderAdapter]) {
            expect(factory({ ...provider, slug: 'brand1-card' })).toBeInstanceOf(AlkasrVipAdapter);
            expect(factory({ ...provider, slug: 'brand-one-card' })).toBeInstanceOf(BrandOneCardAdapter);
            expect(factory({ ...provider, slug: 'almotasim-card' })).toBeInstanceOf(AlmotasimCardAdapter);
        }
    });

    test('sends real HTTP with the private header, encoded customer fields and stable UUID', async () => {
        const received = [];
        const server = http.createServer((req, res) => {
            received.push({ url: new URL(req.url, 'http://localhost'), token: req.headers['api-token'] });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(body()));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            const adapter = new JasserCardAdapter({ ...provider, baseUrl: `http://127.0.0.1:${server.address().port}` });
            const input = { ...params, playerId: 'لاعب & + ? =', serverId: '42&qty=999' };
            await expect(adapter.placeOrder(input)).resolves.toMatchObject({ success: true, providerStatus: 'Completed' });
            await adapter.placeOrder(input);
            const { url, token } = received[0];
            expect(token).toBe(provider.apiToken);
            expect(url.pathname).toBe('/client/api/newOrder/365/params');
            expect(url.searchParams.get('playerId')).toBe(input.playerId);
            expect(url.searchParams.get('serverId')).toBe(input.serverId);
            expect(url.searchParams.getAll('qty')).toEqual(['2']);
            expect(url.searchParams.get('api-token')).toBeNull();
            expect(url.searchParams.get('order_uuid')).toMatch(uuidPattern);
            expect(received[1].url.searchParams.get('order_uuid')).toBe(url.searchParams.get('order_uuid'));
        } finally { await new Promise((resolve) => server.close(resolve)); }
    });
});
