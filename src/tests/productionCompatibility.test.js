'use strict';

jest.mock('../modules/notifications/notification.service', () => ({
    notifyNewTargetOrder: jest.fn(),
    notifyTargetApproved: jest.fn(),
    notifyTargetRejected: jest.fn(),
}));

const authController = require('../modules/auth/auth.controller');
const adminProvidersService = require('../modules/admin/admin.providers.service');
const adminUsersService = require('../modules/admin/admin.users.service');
const targetService = require('../modules/targets/target.service');
const { getProviderAdapter } = require('../modules/providers/adapters/adapter.factory');
const { Provider } = require('../modules/providers/provider.model');
const { TARGET_ORDER_STATUS } = require('../modules/targets/target.model');
const { Setting } = require('../modules/admin/setting.model');
const { invalidateSettingsCache } = require('../modules/admin/admin.settings.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createAdmin,
    createCustomerWithGroup,
} = require('./testHelpers');

const seedTargetPaymentSettings = async () => {
    await Setting.updateOne(
        { key: 'paymentGroups' },
        {
            $set: {
                key: 'paymentGroups',
                value: [{
                    id: 'group-egp',
                    name: 'EGP',
                    isActive: true,
                    methods: [
                        { id: 'instapay', name: 'InstaPay', type: 'mobile_wallet', isActive: true },
                    ],
                }],
            },
        },
        { upsert: true }
    );
    invalidateSettingsCache('paymentGroups');
};

describe('production compatibility contracts', () => {
    beforeAll(connectTestDB);
    afterAll(disconnectTestDB);

    beforeEach(async () => {
        await clearCollections();
    });

    test('admin quota endpoints use real quantity quota fields', async () => {
        const admin = await createAdmin();
        const { customer } = await createCustomerWithGroup(
            { quantityLimit: 10, quantityUsed: 3 },
            { billingMode: 'quantity_only' }
        );

        const current = await adminUsersService.getUserQuota(customer._id);
        expect(current.quota).toMatchObject({
            billingMode: 'quantity_only',
            isQuantityOnly: true,
            quantityLimit: 10,
            quantityUsed: 3,
            quantityRemaining: 7,
        });

        const updated = await adminUsersService.updateUserQuota(customer._id, 20, admin._id, 'monthly quota');
        expect(updated.quota.quantityLimit).toBe(20);
        expect(updated.quota.quantityUsed).toBe(3);
        expect(updated.quota.quantityRemaining).toBe(17);

        const reset = await adminUsersService.resetUserQuota(customer._id, admin._id, 'settled offline');
        expect(reset.quota.quantityLimit).toBe(20);
        expect(reset.quota.quantityUsed).toBe(0);
        expect(reset.quota.quantityRemaining).toBe(20);
    });

    test('/auth/refresh is explicit non-support, not insecure token minting', () => {
        const res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
        };

        authController.refresh({}, res);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: false,
            code: 'REFRESH_NOT_SUPPORTED',
        }));
    });

    test('admin provider responses redact stored API tokens', async () => {
        const admin = await createAdmin();
        const provider = await adminProvidersService.createProvider({
            name: 'Secure Provider',
            slug: 'secure-provider',
            baseUrl: 'https://provider.example/api',
            apiToken: 'provider-secret-token',
            isActive: true,
        }, admin._id);

        expect(provider.apiToken).toBeUndefined();
        expect(provider.apiKey).toBeUndefined();
        expect(provider.hasApiToken).toBe(true);

        const listed = await adminProvidersService.listProviders();
        expect(listed[0].apiToken).toBeUndefined();
        expect(listed[0].hasApiToken).toBe(true);
    });

    test('admin provider token updates preserve existing credentials unless a new token is supplied', async () => {
        const admin = await createAdmin();
        const created = await adminProvidersService.createProvider({
            name: 'Token Provider',
            slug: 'token-provider',
            baseUrl: 'https://provider.example/api',
            apiToken: 'original-token',
            isActive: true,
        }, admin._id);

        await adminProvidersService.updateProvider(created._id, {
            name: 'Renamed Provider',
            isActive: false,
        }, admin._id);
        await expect(Provider.findById(created._id).then((provider) => provider.apiToken)).resolves.toBe('original-token');

        for (const maskedValue of ['[REDACTED]', '********', '••••••••']) {
            await adminProvidersService.updateProvider(created._id, { apiToken: maskedValue }, admin._id);
            await expect(Provider.findById(created._id).then((provider) => provider.apiToken)).resolves.toBe('original-token');
        }

        await adminProvidersService.updateProvider(created._id, { apiToken: 'new-provider-token' }, admin._id);
        await expect(Provider.findById(created._id).then((provider) => provider.apiToken)).resolves.toBe('new-provider-token');
    });

    test('admin provider create and edit preserve Canonical adapterType without exposing its token', async () => {
        const admin = await createAdmin();
        const created = await adminProvidersService.createProvider({
            name: 'Canonical Admin Provider', slug: 'arbitrary-provider-slug',
            adapterType: 'canonical-b2b', baseUrl: 'https://upstream.example/client/api', apiToken: 'test-token',
        }, admin._id);

        expect(created).toMatchObject({ adapterType: 'canonical-b2b', hasApiToken: true });
        expect(created.apiToken).toBeUndefined();

        const updated = await adminProvidersService.updateProvider(created._id, {
            adapterType: 'CANONICAL-B2B',
        }, admin._id);
        expect(updated.adapterType).toBe('canonical-b2b');
        await expect(Provider.findById(created._id).then((provider) => provider.adapterType)).resolves.toBe('canonical-b2b');
    });

    test('production provider adapter resolution fails closed instead of using mock fallback', () => {
        const previousNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';

        try {
            expect(() => getProviderAdapter({
                name: 'Unknown Provider',
                slug: 'unknown-provider',
                baseUrl: 'https://provider.example/api',
                apiToken: 'token',
            })).toThrow(/Mock provider fallback is disabled in production/);

            expect(() => getProviderAdapter({
                name: 'Mock',
                slug: 'mock',
                baseUrl: 'https://provider.example/api',
                apiToken: 'token',
            })).toThrow(/Mock provider fallback is disabled in production/);
        } finally {
            process.env.NODE_ENV = previousNodeEnv;
        }
    });

    test('target status compatibility aliases preserve approve/reject rules', async () => {
        await seedTargetPaymentSettings();
        const admin = await createAdmin();
        const { customer } = await createCustomerWithGroup();
        const app = await targetService.createTargetApp({
            name: 'TikTok Coins',
            unitPrice: 1,
            targetAccountId: 'target-wallet-1',
            allowedPaymentMethods: ['instapay'],
        });

        const order = await targetService.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 10,
            senderId: 'sender-123',
            transferNumber: '01000000000',
            transactionNumber: 'txn-compat-1',
            paymentMethod: 'InstaPay',
            paymentMethodId: 'instapay',
            screenshotProof: 'uploads/targets/proof.png',
        });

        const stillPending = await targetService.updateTargetOrderStatus(order._id, 'PENDING', admin._id);
        expect(stillPending.status).toBe(TARGET_ORDER_STATUS.PENDING);

        const approved = await targetService.updateTargetOrderStatus(order._id, 'APPROVED', admin._id);
        expect(approved.status).toBe(TARGET_ORDER_STATUS.APPROVED);

        await expect(
            targetService.updateTargetOrderStatus(order._id, 'PENDING', admin._id)
        ).rejects.toMatchObject({
            code: 'TARGET_ORDER_PENDING_REVERT_UNSUPPORTED',
        });

        const rejectedOrder = await targetService.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 5,
            senderId: 'sender-456',
            transferNumber: '01000000001',
            transactionNumber: 'txn-compat-2',
            paymentMethod: 'InstaPay',
            paymentMethodId: 'instapay',
            screenshotProof: 'uploads/targets/proof.png',
        });

        const rejected = await targetService.updateTargetOrderStatus(
            rejectedOrder._id,
            'REJECTED',
            admin._id,
            'invalid proof'
        );
        expect(rejected.status).toBe(TARGET_ORDER_STATUS.REJECTED);
        expect(rejected.adminNotes).toBe('invalid proof');
    });
});
