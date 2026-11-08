'use strict';

// Real scheduling/selection/locking code, but no DB, provider HTTP or cron timer.
jest.mock('../modules/providers/adapters/adapter.factory', () => ({ getAdapter: jest.fn() }));
jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));

const mongoose = require('mongoose');
const cron = require('node-cron');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product } = require('../modules/products/product.model');
const { getAdapter } = require('../modules/providers/adapters/adapter.factory');
const sync = require('../modules/providers/providerProductSync.service');
const catalog = require('../modules/providers/providerCatalog.service');
const legacy = require('../modules/providers/sync.service');
const job = require('../modules/providers/syncProvidersJob');
const catalogController = require('../modules/admin/admin.catalog.controller');

let fixtures;
let fetchProducts;
let find;
let select;

beforeEach(() => {
    fixtures = [
        { _id: 'manual', isActive: true, syncInterval: 0 },
        { _id: 'scheduled', isActive: true, syncInterval: 60 },
        { _id: 'legacy', isActive: true },
        { _id: 'inactive', isActive: false, syncInterval: 60 },
    ];
    fetchProducts = jest.fn().mockResolvedValue([]);
    getAdapter.mockImplementation(() => ({ fetchProducts }));
    select = jest.fn();
    find = jest.spyOn(Provider, 'find').mockImplementation((filter) => {
        // Simulate the repository result from the query; no MongoDB is opened.
        select.mockResolvedValue(fixtures.filter((provider) => provider.isActive === filter.isActive
            && (!filter.syncInterval || provider.syncInterval !== filter.syncInterval.$ne)));
        return { select };
    });
    jest.spyOn(Provider, 'findById').mockImplementation(async (id) => fixtures.find((provider) => provider._id === id));
    jest.spyOn(mongoose, 'connect').mockImplementation(() => { throw new Error('No database allowed'); });
    jest.spyOn(mongoose.connection, 'openUri').mockImplementation(() => { throw new Error('No database allowed'); });
    for (const model of [Provider, ProviderProduct, Product]) {
        for (const method of ['create', 'updateMany', 'findByIdAndUpdate', 'findOneAndUpdate', 'deleteOne']) {
            jest.spyOn(model, method).mockImplementation(() => { throw new Error('No database writes allowed'); });
        }
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    job.stop();
    expect(mongoose.connect).not.toHaveBeenCalled();
    expect(mongoose.connection.openUri).not.toHaveBeenCalled();
    for (const model of [Provider, ProviderProduct, Product]) {
        for (const method of ['create', 'updateMany', 'findByIdAndUpdate', 'findOneAndUpdate', 'deleteOne']) {
            expect(model[method]).not.toHaveBeenCalled();
        }
    }
    jest.restoreAllMocks();
});

const dispatchedIds = () => getAdapter.mock.calls.map(([provider]) => provider._id);

test('automatic sync excludes explicit zero and inactive suppliers, preserving legacy missing intervals', async () => {
    const options = { testOnly: true };
    const result = await sync.syncAutomaticProviders(options);
    expect(find).toHaveBeenCalledWith({ isActive: true, syncInterval: { $ne: 0 } });
    expect(select).toHaveBeenCalledWith('_id');
    expect(dispatchedIds()).toEqual(['scheduled', 'legacy']);
    expect(result.map((entry) => entry.providerId)).toEqual(['scheduled', 'legacy']);
    expect(result.every((entry) => entry.result.totalFetched === 0)).toBe(true);
    expect(getAdapter).toHaveBeenCalledWith(fixtures[1], options);
});

test('manual bulk sync retains its query and includes the manual-only supplier', async () => {
    const result = await sync.syncAllProviders();
    expect(find).toHaveBeenCalledWith({ isActive: true });
    expect(dispatchedIds()).toEqual(['manual', 'scheduled', 'legacy']);
    expect(result.map((entry) => entry.providerId)).toEqual(['manual', 'scheduled', 'legacy']);
});

test('the existing admin bulk-sync endpoint still uses manual selection', async () => {
    const response = await new Promise((resolve, reject) => {
        const res = { status: jest.fn().mockReturnThis(), json: resolve };
        catalogController.syncAll({}, res, reject);
    });
    expect(response.success).toBe(true);
    expect(response.data.map((entry) => entry.providerId)).toEqual(['manual', 'scheduled', 'legacy']);
    expect(find).toHaveBeenCalledWith({ isActive: true });
});

test('direct manual sync is still allowed for syncInterval zero', async () => {
    await expect(sync.syncProviderProducts('manual')).resolves.toMatchObject({ providerId: 'manual', totalFetched: 0 });
    expect(dispatchedIds()).toEqual(['manual']);
    expect(find).not.toHaveBeenCalled();
});

test.each(['syncAllProviders', 'syncAutomaticProviders'])('%s isolates failures and releases provider locks', async (operation) => {
    getAdapter.mockImplementation((provider) => ({
        fetchProducts: provider._id === 'scheduled' ? jest.fn().mockRejectedValue(new Error('simulated provider failure')) : fetchProducts,
    }));
    const result = await sync[operation]();
    expect(result.find((entry) => entry.providerId === 'scheduled')).toMatchObject({ error: 'simulated provider failure' });
    expect(result.find((entry) => entry.providerId === 'legacy').result.totalFetched).toBe(0);
    expect(sync.isSyncRunning('scheduled')).toBe(false);
    expect(sync.isSyncRunning('legacy')).toBe(false);
});

test.each(['syncAllProviders', 'syncAutomaticProviders'])('%s returns an empty list when no providers are eligible', async (operation) => {
    fixtures = [];
    await expect(sync[operation]()).resolves.toEqual([]);
    expect(getAdapter).not.toHaveBeenCalled();
});

test('catalog exposes automatic selection and preserves all manual legacy aliases', () => {
    expect(catalog.syncAutomaticProviders).toBe(sync.syncAutomaticProviders);
    expect(catalog.syncAllProviders).toBe(sync.syncAllProviders);
    expect(legacy.syncAllProviders).toBe(sync.syncAllProviders);
    expect(legacy.syncProvider).toBe(sync.syncProviderProducts);
    expect(legacy.recalcSyncPrices).toBe(sync.recalcProductPrices);
});

test('job.runOnce uses automatic selection and forwards options', async () => {
    const options = { testOnly: 'cron' };
    await job.runOnce(options);
    expect(find).toHaveBeenCalledWith({ isActive: true, syncInterval: { $ne: 0 } });
    expect(dispatchedIds()).toEqual(['scheduled', 'legacy']);
    expect(getAdapter).toHaveBeenCalledWith(fixtures[1], options);
    expect(cron.schedule).not.toHaveBeenCalled();
});

test('overlapping job ticks and direct sync calls keep the existing locks', async () => {
    fixtures = [fixtures[1]];
    let release;
    let notifyEntered;
    const entered = new Promise((resolve) => { notifyEntered = resolve; });
    fetchProducts.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; notifyEntered(); }));
    const first = job.runOnce();
    await entered;
    await expect(job.runOnce()).resolves.toBeNull();
    await expect(sync.syncProviderProducts('scheduled')).rejects.toMatchObject({ code: 'SYNC_ALREADY_RUNNING' });
    release([]);
    await first;
    expect(sync.isSyncRunning('scheduled')).toBe(false);
    await expect(job.runOnce()).resolves.toHaveLength(1);
});

test('job resets its running flag after a repository failure', async () => {
    select.mockRejectedValueOnce(new Error('repository unavailable'));
    find.mockReturnValueOnce({ select });
    await expect(job.runOnce()).resolves.toBeNull();
    await expect(job.runOnce()).resolves.toHaveLength(2);
});

test('cron callback delegates to automatic selection without scheduling a real timer', async () => {
    const previousEnv = process.env.NODE_ENV;
    try {
        process.env.NODE_ENV = 'development';
        job.start('0 0,6,12,18 * * *');
        expect(cron.schedule).toHaveBeenCalledWith('0 0,6,12,18 * * *', expect.any(Function));
        await cron.schedule.mock.calls[0][1]();
        expect(dispatchedIds()).toEqual(['scheduled', 'legacy']);
    } finally {
        if (previousEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousEnv;
    }
});
