'use strict';

// Real factory, database, sync, fulfillment and polling; supplier HTTP is simulated.
const axios = require('axios');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Order } = require('../modules/orders/order.model');
const { User } = require('../modules/users/user.model');
const { syncProviderProducts } = require('../modules/providers/providerProductSync.service');
const { executeOrder, pollProcessingOrders } = require('../modules/orders/orderFulfillment.service');
const { connectTestDB, disconnectTestDB, clearCollections, createCustomerWithGroup, createProduct } = require('./testHelpers');

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(clearCollections);
afterEach(() => jest.restoreAllMocks());

const setup = async () => {
    const provider = await Provider.create({ name: 'Jasser Card', slug: 'jasser-card', baseUrl: 'https://www.jasser-card.net', apiToken: 'test-private-token' });
    const other = await Provider.create({ name: 'Existing supplier', slug: 'mock', baseUrl: 'https://example.com' });
    const existing = await ProviderProduct.create({ provider: other._id, externalProductId: '365', rawName: 'Existing UC', rawPrice: '7', isActive: true });
    const client = { get: jest.fn() };
    jest.spyOn(axios, 'create').mockReturnValue(client);
    return { provider, existing, client };
};

const makeOrder = async (provider) => {
    const { customer, group } = await createCustomerWithGroup({ walletBalance: 950 }, { percentage: 0 });
    const raw = await ProviderProduct.create({ provider: provider._id, externalProductId: '365', rawName: 'UC', rawPrice: '50' });
    const product = await createProduct({ provider: provider._id, providerProduct: raw._id, executionType: 'automatic', providerMapping: { player_id: 'playerId' } });
    const order = await Order.create({
        userId: customer._id, productId: product._id, orderNumber: 'JASSER-TEST-001', quantity: 1,
        unitPrice: 50, totalPrice: 50, basePriceSnapshot: 50, markupPercentageSnapshot: 0,
        finalPriceCharged: 50, groupIdSnapshot: group._id, walletDeducted: 50, creditUsedAmount: 0,
        status: 'PROCESSING', executionType: 'automatic', providerCode: 'jasser-card', customerInput: { values: { player_id: '123&qty=99' } },
    });
    return { order, customer };
};

test('catalog sync is scoped to Jasser even when another supplier has the same product ID', async () => {
    const { provider, existing, client } = await setup();
    client.get.mockResolvedValue({ data: [{ id: 365, name: 'UC 60', price: '0.104', available: true, params: ['playerId'], qty_values: ['110', '150', '210'] }] });
    const result = await syncProviderProducts(provider._id);
    expect(result).toMatchObject({ totalFetched: 1, errors: [] });
    const jasser = await ProviderProduct.findOne({ provider: provider._id, externalProductId: '365' });
    expect(jasser).toMatchObject({ rawName: 'UC 60', rawPrice: '0.104', minQty: 110, maxQty: 210 });
    expect(jasser.rawPayload.qty_values).toEqual(['110', '150', '210']);
    expect((await ProviderProduct.findById(existing._id)).toObject()).toEqual(existing.toObject());
});

test.each(['accept', 'wait', 'reject'])('fulfillment routes to Jasser and safely handles %s', async (status) => {
    const { provider, client, existing } = await setup();
    const { order, customer } = await makeOrder(provider);
    client.get.mockResolvedValue({ data: { status, order: { id: 'ID_jasser', status, code: 'DELIVERED_CODE' } } });
    await executeOrder(order._id);
    const updated = await Order.findById(order._id);
    expect(updated.status).toBe(status === 'accept' ? 'COMPLETED' : status === 'wait' ? 'PROCESSING' : 'FAILED');
    expect(updated.providerOrderId).toBe('ID_jasser');
    expect(updated.providerRawResponse.order.code).toBe('DELIVERED_CODE');
    expect(client.get).toHaveBeenCalledWith('/client/api/newOrder/365/params', {
        params: { qty: 1, playerId: '123&qty=99', order_uuid: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    });
    expect(Number((await User.findById(customer._id)).walletBalance)).toBe(status === 'reject' ? 1000 : 950);
    expect((await ProviderProduct.findById(existing._id)).toObject()).toEqual(existing.toObject());
});

test('lost placement response is recovered by cron using the same UUID with no second purchase or refund', async () => {
    const { provider, client } = await setup();
    const { order, customer } = await makeOrder(provider);
    client.get.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({ data: { orders: [] } });
    await executeOrder(order._id);
    expect(await Order.findById(order._id)).toMatchObject({ status: 'PROCESSING', providerStatus: 'PLACEMENT_UNCERTAIN', providerOrderId: null });
    const uuid = client.get.mock.calls[0][1].params.order_uuid;
    client.get.mockResolvedValue({ data: { orders: [{ id: 'ID_recovered', status: 'accept', code: 'RECOVERED_CODE' }] } });
    await pollProcessingOrders();
    expect(await Order.findById(order._id)).toMatchObject({ status: 'COMPLETED', providerOrderId: 'ID_recovered' });
    expect(client.get).toHaveBeenLastCalledWith('/client/api/check', { params: { orders: JSON.stringify([uuid]), uuid: 1 } });
    expect(client.get.mock.calls.filter(([url]) => url.includes('/newOrder/'))).toHaveLength(1);
    expect(Number((await User.findById(customer._id)).walletBalance)).toBe(950);
});
