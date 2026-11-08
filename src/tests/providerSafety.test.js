'use strict';

// No DB connection or provider HTTP: real services/controllers/model validation,
// with every persistence operation used by these tests replaced by a spy.
jest.mock('../modules/audit/audit.service', () => ({ createAuditLog: jest.fn() }));
jest.mock('../modules/providers/adapters/adapter.factory', () => ({ getProviderAdapter: jest.fn(), getAdapter: jest.fn() }));

const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { Product } = require('../modules/products/product.model');
const { toSafeProviderDTO } = require('../modules/providers/provider.dto');
const providerService = require('../modules/providers/provider.service');
const adminService = require('../modules/admin/admin.providers.service');
const providerController = require('../modules/providers/provider.controller');
const adminController = require('../modules/admin/admin.providers.controller');
const providerValidation = require('../modules/providers/provider.validation');
const { schemas } = require('../modules/admin/admin.validation');
const { createAuditLog } = require('../modules/audit/audit.service');
const { getProviderAdapter, getAdapter } = require('../modules/providers/adapters/adapter.factory');

const credentials = { apiToken: 'private-token-never-return', apiKey: 'private-key-never-return' };
const fields = { name: 'Safety Test', slug: 'safety-test', baseUrl: 'https://provider.invalid', ...credentials, supportedFeatures: ['fetchProducts'] };
const makeDocument = (overrides = {}) => new Provider({ ...fields, ...overrides });
const invoke = (handler, body = {}, id = new mongoose.Types.ObjectId().toString()) => new Promise((resolve, reject) => {
    const res = { status: jest.fn().mockReturnThis(), json: (payload) => resolve(JSON.parse(JSON.stringify(payload))) };
    handler({ body, params: { id }, query: {}, user: { _id: new mongoose.Types.ObjectId() } }, res, reject);
});
const expectSafe = (payload, { hasApiToken = true, hasApiKey = true } = {}) => {
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(credentials.apiToken);
    expect(serialized).not.toContain(credentials.apiKey);
    expect(payload).not.toHaveProperty('apiToken');
    expect(payload).not.toHaveProperty('apiKey');
    expect(payload).not.toHaveProperty('effectiveToken');
    expect(payload).toMatchObject({ hasApiToken, hasApiKey });
};

beforeEach(() => {
    jest.spyOn(mongoose, 'connect').mockImplementation(() => { throw new Error('Database connections forbidden in safety tests'); });
    jest.spyOn(mongoose.connection, 'openUri').mockImplementation(() => { throw new Error('Database connections forbidden in safety tests'); });
});
afterEach(() => {
    expect(mongoose.connect).not.toHaveBeenCalled();
    expect(mongoose.connection.openUri).not.toHaveBeenCalled();
    expect(getProviderAdapter).not.toHaveBeenCalled();
    expect(getAdapter).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});

describe('Shared safe provider DTO', () => {
    test.each([
        [credentials, true, true],
        [{ apiToken: 'token', apiKey: null }, true, false],
        [{ apiToken: null, apiKey: 'legacy' }, true, true],
        [{ apiToken: null, apiKey: null }, false, false],
        [{ apiToken: '', apiKey: '' }, false, false],
    ])('reports credential presence without returning secrets: %j', (secrets, hasApiToken, hasApiKey) => {
        const source = { ...fields, ...secrets, effectiveToken: 'derived-secret', unexpectedSecret: 'future-secret' };
        const dto = toSafeProviderDTO(source);
        expectSafe(dto, { hasApiToken, hasApiKey });
        expect(dto).not.toHaveProperty('unexpectedSecret');
        expect(source).toMatchObject(secrets);
        expect(dto).toMatchObject({ name: fields.name, slug: fields.slug, supportedFeatures: fields.supportedFeatures });
        expect(toSafeProviderDTO(dto)).toEqual(dto);
    });

    test('serializes a Mongoose document without mutating internal credentials or derived token', () => {
        const document = makeDocument();
        expectSafe(toSafeProviderDTO(document));
        expect(document.apiToken).toBe(credentials.apiToken);
        expect(document.apiKey).toBe(credentials.apiKey);
        expect(document.effectiveToken).toBe(credentials.apiToken);
        expect(document.toObject().apiToken).toBe(credentials.apiToken);
    });
});

describe.each([
    ['provider', providerController],
    ['admin', adminController],
])('%s CRUD response privacy', (path, controller) => {
    const unwrap = (response) => path === 'admin' ? response.data.provider : response.data;

    test('create returns a safe DTO while saving both credentials', async () => {
        const document = makeDocument();
        jest.spyOn(Provider, 'findOne').mockResolvedValue(null);
        const create = jest.spyOn(Provider, 'create').mockResolvedValue(document);
        const response = await invoke(controller.createProvider, fields);
        expect(response.success).toBe(true);
        expectSafe(unwrap(response));
        expect(create).toHaveBeenCalledWith(expect.objectContaining(credentials));
        expect(document.apiToken).toBe(credentials.apiToken);
    });

    test('list preserves the response envelope and hides keys in every entry', async () => {
        const documents = [makeDocument(), makeDocument({ apiToken: null, apiKey: null })];
        const sort = jest.fn().mockResolvedValue(documents);
        jest.spyOn(Provider, 'find').mockReturnValue({ sort });
        const response = await invoke(controller.listProviders);
        const listed = path === 'admin' ? response.data.providers : response.data;
        expectSafe(listed[0]);
        expectSafe(listed[1], { hasApiToken: false, hasApiKey: false });
        expect(sort).toHaveBeenCalledWith({ name: 1 });
    });

    test('get hides credentials', async () => {
        jest.spyOn(Provider, 'findById').mockResolvedValue(makeDocument());
        expectSafe(unwrap(await invoke(controller.getProvider || controller.getProviderById)));
    });

    test('update hides credentials and preserves omitted credentials', async () => {
        const document = makeDocument();
        jest.spyOn(Provider, 'findById').mockResolvedValue(document);
        jest.spyOn(document, 'save').mockResolvedValue(document);
        const update = jest.spyOn(Provider, 'findByIdAndUpdate').mockResolvedValue(document);
        expectSafe(unwrap(await invoke(controller.updateProvider, { slug: 'updated', supportedFeatures: [] })));
        expect(document.apiToken).toBe(credentials.apiToken);
        expect(document.apiKey).toBe(credentials.apiKey);
        if (path === 'provider') {
            expect(update.mock.calls[0][1].$set).toEqual({ slug: 'updated', supportedFeatures: [] });
        }
    });

    test('delete hides the nested/flat provider while preserving detach counts', async () => {
        jest.spyOn(Provider, 'findById').mockResolvedValue(makeDocument());
        jest.spyOn(ProviderProduct, 'find').mockReturnValue({ select: () => ({ lean: async () => [] }) });
        jest.spyOn(Product, 'updateMany').mockResolvedValue({ modifiedCount: 2 });
        jest.spyOn(Provider, 'deleteOne').mockResolvedValue({ deletedCount: 1 });
        const response = await invoke(controller.deleteProvider);
        expect((path === 'admin' ? response.data.provider : response.data).detachedProducts).toBe(2);
        expectSafe(response.data.provider);
    });
});

test('admin toggle returns both presence flags and keeps credentials and audit redaction', async () => {
    const document = makeDocument();
    jest.spyOn(Provider, 'findById').mockResolvedValue(document);
    jest.spyOn(document, 'save').mockResolvedValue(document);
    const response = await invoke(adminController.toggleProvider);
    expectSafe(response.data.provider);
    expect(response.data.isActive).toBe(false);
    expect(document.apiToken).toBe(credentials.apiToken);
    expect(JSON.stringify(createAuditLog.mock.calls)).not.toContain(credentials.apiToken);
    expect(JSON.stringify(createAuditLog.mock.calls)).not.toContain(credentials.apiKey);
});

test.each(['[REDACTED]', '********', '', null])('admin update preserves an existing token for placeholder %s', async (apiToken) => {
    const document = makeDocument();
    jest.spyOn(Provider, 'findById').mockResolvedValue(document);
    jest.spyOn(document, 'save').mockResolvedValue(document);
    expectSafe(await adminService.updateProvider(document._id, { apiToken }));
    expect(document.apiToken).toBe(credentials.apiToken);
    expect(JSON.stringify(createAuditLog.mock.calls)).not.toContain(credentials.apiToken);
});

describe('Provider optional fields through validation, service and model', () => {
    const validate = async (mode, body) => {
        const req = { body: { ...body }, params: { id: new mongoose.Types.ObjectId().toString() } };
        await Promise.all(providerValidation[`${mode}ProviderValidation`].map((chain) => chain.run(req)));
        return { req, errors: validationResult(req).array() };
    };

    test.each(['create', 'update'])('%s normalizes slug and accepts only string feature arrays in both validators', async (mode) => {
        const body = { ...(mode === 'create' ? { name: fields.name, baseUrl: fields.baseUrl } : {}), slug: '  CUSTOM-SLUG  ', supportedFeatures: ['fetchProducts', 'checkOrders'] };
        const { req, errors } = await validate(mode, body);
        expect(errors).toEqual([]);
        expect(req.body.slug).toBe('custom-slug');
        const joi = schemas[`${mode}Provider`].validate(body);
        expect(joi.error).toBeUndefined();
        expect(joi.value.slug).toBe(req.body.slug);
        const document = makeDocument(req.body);
        await expect(document.validate()).resolves.toBeUndefined();
        expect(document.slug).toBe('custom-slug');
        expect([...document.supportedFeatures]).toEqual(body.supportedFeatures);
    });

    test.each(['create', 'update'])('%s rejects invalid slugs and non-string features consistently', async (mode) => {
        const base = mode === 'create' ? { name: fields.name, baseUrl: fields.baseUrl } : {};
        for (const invalid of [{ slug: 'invalid/slug' }, { supportedFeatures: 'fetchProducts' }, { supportedFeatures: [42] }, { supportedFeatures: [{}] }]) {
            const body = { ...base, ...invalid };
            expect((await validate(mode, body)).errors.length).toBeGreaterThan(0);
            expect(schemas[`${mode}Provider`].validate(body).error).toBeDefined();
        }
    });

    test('create forwards slug/features through the real model without dropping values', async () => {
        jest.spyOn(Provider, 'findOne').mockResolvedValue(null);
        const create = jest.spyOn(Provider, 'create').mockImplementation(async (data) => {
            const document = new Provider(data);
            await document.validate();
            return document;
        });
        const document = await providerService.createProvider({ ...fields, slug: 'CUSTOM-SLUG', supportedFeatures: ['placeOrder', 'fetchProducts'], syncInterval: 0 });
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ slug: 'CUSTOM-SLUG', supportedFeatures: ['placeOrder', 'fetchProducts'], syncInterval: 0 }));
        expect(document.slug).toBe('custom-slug');
        expect([...document.supportedFeatures]).toEqual(['placeOrder', 'fetchProducts']);
        expect(document.syncInterval).toBe(0);
    });

    test('update persists slug/features, allows clearing features, and ignores unsupported fields', async () => {
        const document = makeDocument();
        const update = jest.spyOn(Provider, 'findByIdAndUpdate').mockImplementation(async (id, { $set }) => {
            document.set($set);
            await document.validate();
            return document;
        });
        await providerService.updateProvider(document._id, { slug: 'CHANGED', supportedFeatures: ['checkOrders'], unexpectedField: 'ignored' });
        expect(document.slug).toBe('changed');
        expect([...document.supportedFeatures]).toEqual(['checkOrders']);
        expect(update).toHaveBeenCalledWith(document._id, { $set: { slug: 'CHANGED', supportedFeatures: ['checkOrders'] } }, { new: true, runValidators: true });
        await providerService.updateProvider(document._id, { supportedFeatures: [] });
        expect([...document.supportedFeatures]).toEqual([]);
        expect(document.slug).toBe('changed');
        expect(document.apiToken).toBe(credentials.apiToken);
        expect(document.apiKey).toBe(credentials.apiKey);
    });

    test('omitted optional fields retain model defaults', async () => {
        jest.spyOn(Provider, 'findOne').mockResolvedValue(null);
        jest.spyOn(Provider, 'create').mockImplementation(async (data) => new Provider(data));
        const document = await providerService.createProvider({ name: 'Legacy Provider', baseUrl: fields.baseUrl });
        expect(document.slug).toBeUndefined(); // Existing pre-save hook still generates it on a real save.
        expect([...document.supportedFeatures]).toEqual([]);
        expect(document.syncInterval).toBe(60);
    });

    test('admin create and update retain slug/features with safe DTOs', async () => {
        const document = makeDocument();
        jest.spyOn(Provider, 'create').mockImplementation(async (data) => { document.set(data); await document.validate(); return document; });
        jest.spyOn(Provider, 'findById').mockResolvedValue(document);
        jest.spyOn(document, 'save').mockImplementation(async () => { await document.validate(); return document; });
        const created = await adminService.createProvider({ ...fields, slug: 'INITIAL', supportedFeatures: ['fetchProducts'] });
        expect(created).toMatchObject({ slug: 'initial', supportedFeatures: ['fetchProducts'] });
        expectSafe(created);
        const updated = await adminService.updateProvider(document._id, { slug: 'CHANGED', supportedFeatures: [] });
        expect(updated).toMatchObject({ slug: 'changed', supportedFeatures: [] });
        expectSafe(updated);
    });
});
