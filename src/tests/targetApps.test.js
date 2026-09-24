'use strict';

const fs = require('fs/promises');
const path = require('path');

jest.mock('../modules/notifications/notification.service', () => ({
    notifyNewTargetOrder: jest.fn(),
    notifyTargetApproved: jest.fn(),
    notifyTargetRejected: jest.fn(),
}));

const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
    createAdmin,
} = require('./testHelpers');
const targetSvc = require('../modules/targets/target.service');
const targetCtrl = require('../modules/targets/target.controller');
const { TargetOrder, TARGET_ORDER_STATUS } = require('../modules/targets/target.model');
const { AuditLog } = require('../modules/audit/audit.model');
const { Setting } = require('../modules/admin/setting.model');
const { invalidateSettingsCache } = require('../modules/admin/admin.settings.service');
const notificationSvc = require('../modules/notifications/notification.service');
const { schemas: targetSchemas } = require('../modules/targets/target.validation');
const { TARGET_ORDER_ACTIONS, ACTOR_ROLES } = require('../modules/audit/audit.constants');
const { validateUploadedFileSignature } = require('../shared/middlewares/upload');

const flushAudit = () => new Promise((resolve) => setTimeout(resolve, 100));
const uploadsDir = path.resolve(__dirname, '../../uploads/targets');
const seedTargetPaymentSettings = async (methods = [
    { id: 'vodafone cash', name: 'Vodafone Cash', type: 'mobile_wallet', isActive: true },
    { id: 'instapay', name: 'InstaPay', type: 'mobile_wallet', isActive: true },
    { id: 'binance', name: 'Binance', type: 'usdt', isActive: true },
]) => {
    await Setting.updateOne(
        { key: 'paymentGroups' },
        {
            $set: {
                key: 'paymentGroups',
                value: [{
                    id: 'group-egp',
                    name: 'EGP',
                    isActive: true,
                    methods,
                }],
            },
        },
        { upsert: true }
    );
    invalidateSettingsCache('paymentGroups');
};

describe('Target app purchasing', () => {
    beforeAll(connectTestDB);
    afterAll(disconnectTestDB);
    beforeEach(async () => {
        await clearCollections();
        notificationSvc.notifyNewTargetOrder.mockReset();
        notificationSvc.notifyTargetApproved.mockReset();
        notificationSvc.notifyTargetRejected.mockReset();
        await seedTargetPaymentSettings();
    });

    test('creates target orders from an active app and snapshots app pricing', async () => {
        const { customer } = await createCustomerWithGroup();
        const app = await targetSvc.createTargetApp({
            name: 'TikTok Coins',
            unitPrice: 1.25,
            targetAccountId: 'target-wallet-1',
            allowedPaymentMethods: ['Vodafone Cash', 'InstaPay'],
            image: 'uploads/target-apps/tiktok.png',
        });

        const order = await targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 10,
            senderId: 'sender-123',
            transferNumber: '01000000000',
            transactionNumber: 'txn-0000',
            paymentMethod: 'InstaPay',
            paymentMethodId: 'instapay',
            screenshotProof: 'uploads/targets/proof.png',
        });

        expect(order.appId.toString()).toBe(app._id.toString());
        expect(order.appNameSnapshot).toBe('TikTok Coins');
        expect(order.unitPriceSnapshot).toBe(1.25);
        expect(order.totalPrice).toBe(12.5);
        expect(order.targetAccountIdSnapshot).toBe('target-wallet-1');
        expect(order.transferNumber).toBe('01000000000');
        expect(order.transactionNumber).toBe('txn-0000');
        expect(order.paymentMethod).toBe('instapay');
        expect(order.paymentMethodNameSnapshot).toBe('InstaPay');
        expect(notificationSvc.notifyNewTargetOrder).toHaveBeenCalledTimes(1);
    });

    test('accepts the frontend paymentMethodId contract against active payment settings', async () => {
        await seedTargetPaymentSettings([{
            id: 'custom-wallet',
            name: 'Custom Wallet',
            type: 'mobile_wallet',
            isActive: true,
        }]);

        const { customer } = await createCustomerWithGroup();
        const app = await targetSvc.createTargetApp({
            name: 'Custom App',
            unitPrice: 3,
            targetAccountId: 'custom-target-account',
            allowedPaymentMethods: ['custom-wallet'],
        });

        const order = await targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 4,
            senderId: 'sender-custom',
            transferNumber: '01000000009',
            transactionNumber: 'txn-custom',
            paymentMethod: 'Custom Wallet',
            paymentMethodId: 'custom-wallet',
            screenshotProof: 'uploads/targets/proof.png',
        });

        expect(app.allowedPaymentMethods).toEqual(['custom-wallet']);
        expect(order.paymentMethod).toBe('custom-wallet');
        expect(order.paymentMethodIdSnapshot).toBe('custom-wallet');
        expect(order.paymentMethodNameSnapshot).toBe('Custom Wallet');
    });

    test('rejects inactive or unknown payment methods', async () => {
        await seedTargetPaymentSettings([{
            id: 'inactive-wallet',
            name: 'Inactive Wallet',
            type: 'mobile_wallet',
            isActive: false,
        }]);

        const { customer } = await createCustomerWithGroup();
        const app = await targetSvc.createTargetApp({
            name: 'Inactive Payment App',
            unitPrice: 2,
            targetAccountId: 'inactive-target-account',
            allowedPaymentMethods: ['inactive-wallet'],
        });

        await expect(targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 5,
            senderId: 'sender-000',
            transferNumber: '01000000010',
            transactionNumber: 'txn-inactive',
            paymentMethod: 'Inactive Wallet',
            paymentMethodId: 'inactive-wallet',
            screenshotProof: 'uploads/targets/proof.png',
        })).rejects.toMatchObject({ code: 'TARGET_PAYMENT_METHOD_INACTIVE' });
    });

    test('fails closed when no target payment configuration exists unless legacy fallback is explicitly enabled', async () => {
        await Setting.deleteOne({ key: 'paymentGroups' });
        invalidateSettingsCache('paymentGroups');

        const { customer } = await createCustomerWithGroup();
        const app = await targetSvc.createTargetApp({
            name: 'No Config App',
            unitPrice: 2,
            targetAccountId: 'no-config-target-account',
            allowedPaymentMethods: ['vodafone cash'],
        });

        await expect(targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 5,
            senderId: 'sender-no-config',
            transferNumber: '01000000020',
            transactionNumber: 'txn-no-config',
            paymentMethod: 'Vodafone Cash',
            paymentMethodId: 'vodafone cash',
            screenshotProof: 'uploads/targets/proof.png',
        })).rejects.toMatchObject({ code: 'TARGET_PAYMENT_CONFIGURATION_MISSING' });

        const previous = process.env.TARGET_PAYMENT_LEGACY_FALLBACK_ENABLED;
        process.env.TARGET_PAYMENT_LEGACY_FALLBACK_ENABLED = 'true';
        try {
            await expect(targetSvc.createTargetOrder({
                userId: customer._id,
                appId: app._id,
                coinAmount: 5,
                senderId: 'sender-no-config',
                transferNumber: '01000000020',
                transactionNumber: 'txn-no-config-legacy',
                paymentMethod: 'Vodafone Cash',
                paymentMethodId: 'vodafone cash',
                screenshotProof: 'uploads/targets/proof.png',
            })).resolves.toMatchObject({ paymentMethod: 'vodafone cash' });
        } finally {
            if (previous === undefined) {
                delete process.env.TARGET_PAYMENT_LEGACY_FALLBACK_ENABLED;
            } else {
                process.env.TARGET_PAYMENT_LEGACY_FALLBACK_ENABLED = previous;
            }
        }
    });

    test('rejects payment methods not allowed by the selected app', async () => {
        const { customer } = await createCustomerWithGroup();
        const app = await targetSvc.createTargetApp({
            name: 'PUBG Mobile',
            unitPrice: 2,
            targetAccountId: 'pubg-target-account',
            allowedPaymentMethods: ['Binance'],
        });

        await expect(targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 5,
            senderId: 'sender-456',
            transferNumber: '01000000001',
            transactionNumber: 'txn-0001',
            paymentMethod: 'Vodafone Cash',
            screenshotProof: 'uploads/targets/proof.png',
        })).rejects.toMatchObject({ code: 'TARGET_PAYMENT_METHOD_NOT_ALLOWED' });
    });

    test('separates missing and inactive target app failures before creating an order', async () => {
        const { customer } = await createCustomerWithGroup();
        const app = await targetSvc.createTargetApp({
            name: 'Retired App',
            unitPrice: 2,
            targetAccountId: 'retired-target-account',
            allowedPaymentMethods: ['vodafone cash'],
        });
        await targetSvc.deactivateTargetApp(app._id);

        await expect(targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 5,
            senderId: 'sender-inactive',
            transferNumber: '01000000011',
            transactionNumber: 'txn-inactive-app',
            paymentMethod: 'Vodafone Cash',
            paymentMethodId: 'vodafone cash',
            screenshotProof: 'uploads/targets/proof.png',
        })).rejects.toMatchObject({ code: 'TARGET_APP_INACTIVE' });

        await expect(targetSvc.createTargetOrder({
            userId: customer._id,
            appId: '507f1f77bcf86cd799439011',
            coinAmount: 5,
            senderId: 'sender-missing',
            transferNumber: '01000000012',
            transactionNumber: 'txn-missing-app',
            paymentMethod: 'Vodafone Cash',
            paymentMethodId: 'vodafone cash',
            screenshotProof: 'uploads/targets/proof.png',
        })).rejects.toMatchObject({ code: 'TARGET_APP_NOT_FOUND' });

        await expect(TargetOrder.countDocuments()).resolves.toBe(0);
    });

    test('reuses an existing target order for a repeated idempotency key', async () => {
        const { customer } = await createCustomerWithGroup();
        const app = await targetSvc.createTargetApp({
            name: 'Idempotent App',
            unitPrice: 1,
            targetAccountId: 'idempotent-target-account',
            allowedPaymentMethods: ['vodafone cash'],
        });

        const first = await targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 10,
            senderId: 'sender-idem',
            transferNumber: '01000000013',
            transactionNumber: 'txn-idem-1',
            paymentMethod: 'Vodafone Cash',
            paymentMethodId: 'vodafone cash',
            screenshotProof: 'uploads/targets/proof-1.png',
            idempotencyKey: 'target-idem-001',
        });

        const replay = await targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 10,
            senderId: 'sender-idem',
            transferNumber: '01000000013',
            transactionNumber: 'txn-idem-1',
            paymentMethod: 'Vodafone Cash',
            paymentMethodId: 'vodafone cash',
            screenshotProof: 'uploads/targets/proof-2.png',
            idempotencyKey: 'target-idem-001',
        });

        expect(replay._id.toString()).toBe(first._id.toString());
        expect(replay.$locals.idempotentReplay).toBe(true);
        await expect(TargetOrder.countDocuments({ userId: customer._id })).resolves.toBe(1);
    });

    test('deletes a newly uploaded duplicate proof when a valid idempotent replay returns the existing order', async () => {
        const { customer } = await createCustomerWithGroup();
        const app = await targetSvc.createTargetApp({
            name: 'Replay Cleanup App',
            unitPrice: 1,
            targetAccountId: 'replay-cleanup-target-account',
            allowedPaymentMethods: ['vodafone cash'],
        });
        const payload = {
            userId: customer._id,
            appId: app._id,
            coinAmount: 3,
            senderId: 'sender-cleanup',
            transferNumber: '01000000027',
            transactionNumber: 'txn-cleanup',
            paymentMethod: 'Vodafone Cash',
            paymentMethodId: 'vodafone cash',
            idempotencyKey: 'target-cleanup-001',
        };

        const first = await targetSvc.createTargetOrder({
            ...payload,
            screenshotProof: 'uploads/targets/proof-existing.png',
        });

        await fs.mkdir(uploadsDir, { recursive: true });
        const duplicateFilename = 'proof-duplicate-cleanup.png';
        const duplicatePath = path.join(uploadsDir, duplicateFilename);
        await fs.writeFile(duplicatePath, 'duplicate-proof');

        await new Promise((resolve, reject) => {
            const res = {
                status: jest.fn().mockReturnThis(),
                json: jest.fn((body) => {
                    try {
                        expect(res.status).toHaveBeenCalledWith(201);
                        expect(String(body.data._id)).toBe(String(first._id));
                        resolve();
                    } catch (err) {
                        reject(err);
                    }
                }),
            };
            targetCtrl.createTargetOrder({
                file: { filename: duplicateFilename },
                body: {
                    appId: String(app._id),
                    coinAmount: payload.coinAmount,
                    senderId: payload.senderId,
                    transferNumber: payload.transferNumber,
                    transactionNumber: payload.transactionNumber,
                    paymentMethod: payload.paymentMethod,
                    paymentMethodId: payload.paymentMethodId,
                    idempotencyKey: payload.idempotencyKey,
                    targetAccountIdSnapshot: 'customer-spoofed-value',
                },
                user: customer,
                get: (header) => (header === 'User-Agent' ? 'jest' : null),
                ip: '127.0.0.1',
            }, res, reject);
        });

        await expect(fs.access(duplicatePath)).rejects.toThrow();
    });

    test('rejects the same idempotency key with a different material payload', async () => {
        const { customer } = await createCustomerWithGroup();
        const app = await targetSvc.createTargetApp({
            name: 'Payload Guard App',
            unitPrice: 1,
            targetAccountId: 'payload-guard-target-account',
            allowedPaymentMethods: ['vodafone cash'],
        });

        await targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 10,
            senderId: 'sender-payload',
            transferNumber: '01000000021',
            transactionNumber: 'txn-payload-1',
            paymentMethod: 'Vodafone Cash',
            paymentMethodId: 'vodafone cash',
            screenshotProof: 'uploads/targets/proof-1.png',
            idempotencyKey: 'target-payload-001',
        });

        await expect(targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 11,
            senderId: 'sender-payload',
            transferNumber: '01000000021',
            transactionNumber: 'txn-payload-1',
            paymentMethod: 'Vodafone Cash',
            paymentMethodId: 'vodafone cash',
            screenshotProof: 'uploads/targets/proof-2.png',
            idempotencyKey: 'target-payload-001',
        })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' });

        await expect(TargetOrder.countDocuments({ userId: customer._id })).resolves.toBe(1);
    });

    test('failed creation does not reserve an idempotency key permanently', async () => {
        const { customer } = await createCustomerWithGroup();
        const app = await targetSvc.createTargetApp({
            name: 'Failed Key App',
            unitPrice: 1,
            targetAccountId: 'failed-key-target-account',
            allowedPaymentMethods: ['vodafone cash'],
        });

        await Setting.deleteOne({ key: 'paymentGroups' });
        invalidateSettingsCache('paymentGroups');

        const payload = {
            userId: customer._id,
            appId: app._id,
            coinAmount: 1,
            senderId: 'sender-failed-key',
            transferNumber: '01000000028',
            transactionNumber: 'txn-failed-key',
            paymentMethod: 'Vodafone Cash',
            paymentMethodId: 'vodafone cash',
            screenshotProof: 'uploads/targets/proof.png',
            idempotencyKey: 'target-failed-key',
        };

        await expect(targetSvc.createTargetOrder(payload)).rejects.toMatchObject({
            code: 'TARGET_PAYMENT_CONFIGURATION_MISSING',
        });
        await expect(TargetOrder.countDocuments({ idempotencyKey: payload.idempotencyKey })).resolves.toBe(0);

        await seedTargetPaymentSettings();
        await expect(targetSvc.createTargetOrder(payload)).resolves.toMatchObject({
            idempotencyKey: payload.idempotencyKey,
        });
    });

    test('allows multiple requests without idempotency keys and treats empty keys as missing', async () => {
        const { customer } = await createCustomerWithGroup();
        const app = await targetSvc.createTargetApp({
            name: 'No Key App',
            unitPrice: 1,
            targetAccountId: 'no-key-target-account',
            allowedPaymentMethods: ['vodafone cash'],
        });

        await targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 1,
            senderId: 'sender-no-key-1',
            transferNumber: '01000000022',
            transactionNumber: 'txn-no-key-1',
            paymentMethod: 'Vodafone Cash',
            paymentMethodId: 'vodafone cash',
            screenshotProof: 'uploads/targets/proof-1.png',
        });
        await targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 2,
            senderId: 'sender-no-key-2',
            transferNumber: '01000000023',
            transactionNumber: 'txn-no-key-2',
            paymentMethod: 'Vodafone Cash',
            paymentMethodId: 'vodafone cash',
            screenshotProof: 'uploads/targets/proof-2.png',
            idempotencyKey: '   ',
        });

        const orders = await TargetOrder.find({ userId: customer._id }).lean();
        expect(orders).toHaveLength(2);
        expect(orders.every((order) => order.idempotencyKey === undefined)).toBe(true);
    });

    test('scopes idempotency keys to the authenticated user', async () => {
        const [{ customer: firstCustomer }, { customer: secondCustomer }] = await Promise.all([
            createCustomerWithGroup({ email: 'first-target@example.com' }),
            createCustomerWithGroup({ email: 'second-target@example.com' }),
        ]);
        const app = await targetSvc.createTargetApp({
            name: 'Scoped Key App',
            unitPrice: 1,
            targetAccountId: 'scoped-key-target-account',
            allowedPaymentMethods: ['vodafone cash'],
        });

        await targetSvc.createTargetOrder({
            userId: firstCustomer._id,
            appId: app._id,
            coinAmount: 1,
            senderId: 'sender-scope-1',
            transferNumber: '01000000024',
            transactionNumber: 'txn-scope-1',
            paymentMethod: 'Vodafone Cash',
            paymentMethodId: 'vodafone cash',
            screenshotProof: 'uploads/targets/proof-1.png',
            idempotencyKey: 'target-shared-key',
        });
        await targetSvc.createTargetOrder({
            userId: secondCustomer._id,
            appId: app._id,
            coinAmount: 1,
            senderId: 'sender-scope-1',
            transferNumber: '01000000024',
            transactionNumber: 'txn-scope-1',
            paymentMethod: 'Vodafone Cash',
            paymentMethodId: 'vodafone cash',
            screenshotProof: 'uploads/targets/proof-2.png',
            idempotencyKey: 'target-shared-key',
        });

        await expect(TargetOrder.countDocuments({ idempotencyKey: 'target-shared-key' })).resolves.toBe(2);
    });

    test('uses the target app account snapshot and ignores customer-supplied account values', async () => {
        const { customer } = await createCustomerWithGroup();
        const app = await targetSvc.createTargetApp({
            name: 'Trusted Account App',
            unitPrice: 1,
            targetAccountId: 'real-target-account',
            allowedPaymentMethods: ['vodafone cash'],
        });

        const spoofed = await targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 1,
            senderId: 'sender-spoof',
            transferNumber: '01000000025',
            transactionNumber: 'txn-spoof',
            paymentMethod: 'Vodafone Cash',
            paymentMethodId: 'vodafone cash',
            targetAccountIdSnapshot: 'attacker-account',
            targetAccount: { value: 'nested-attacker-account' },
            destinationAccountId: 'alias-attacker-account',
            screenshotProof: 'uploads/targets/proof.png',
        });

        expect(spoofed.targetAccountIdSnapshot).toBe('real-target-account');

        app.targetAccountId = 'new-target-account';
        await app.save();
        const stored = await TargetOrder.findById(spoofed._id).lean();
        expect(stored.targetAccountIdSnapshot).toBe('real-target-account');
    });

    test('rejects target orders when the target app account is missing instead of trusting customer payload', async () => {
        const { customer } = await createCustomerWithGroup();
        const app = await targetSvc.createTargetApp({
            name: 'Missing Account App',
            unitPrice: 1,
            allowedPaymentMethods: ['vodafone cash'],
        });

        await expect(targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 1,
            senderId: 'sender-missing-account',
            transferNumber: '01000000026',
            transactionNumber: 'txn-missing-account',
            paymentMethod: 'Vodafone Cash',
            paymentMethodId: 'vodafone cash',
            targetAccountIdSnapshot: 'customer-supplied-account',
            screenshotProof: 'uploads/targets/proof.png',
        })).rejects.toMatchObject({ code: 'TARGET_ACCOUNT_CONFIGURATION_MISSING' });
    });

    test('notification failures do not reject or roll back target creation', async () => {
        notificationSvc.notifyNewTargetOrder.mockImplementationOnce(() => {
            throw new Error('notification down');
        });

        const { customer } = await createCustomerWithGroup();
        const app = await targetSvc.createTargetApp({
            name: 'Notification Safe App',
            unitPrice: 1,
            targetAccountId: 'notification-safe-target-account',
            allowedPaymentMethods: ['vodafone cash'],
        });

        await expect(targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 1,
            senderId: 'sender-notify',
            transferNumber: '01000000014',
            transactionNumber: 'txn-notify',
            paymentMethod: 'Vodafone Cash',
            paymentMethodId: 'vodafone cash',
            screenshotProof: 'uploads/targets/proof.png',
        })).resolves.toMatchObject({ status: TARGET_ORDER_STATUS.PENDING });
        await expect(TargetOrder.countDocuments()).resolves.toBe(1);
    });

    test('admin rejection validation requires a non-empty reason and accepts existing aliases', () => {
        expect(targetSchemas.rejectTargetOrder.validate({ adminNotes: '' }).error).toBeTruthy();

        const { error, value } = targetSchemas.rejectTargetOrder.validate({ rejectionReason: 'Screenshot is unreadable' });
        expect(error).toBeUndefined();
        expect(value).toEqual({ adminNotes: 'Screenshot is unreadable' });
    });

    test('deactivates target apps and hides them from customer app lists', async () => {
        const activeApp = await targetSvc.createTargetApp({
            name: 'Active App',
            unitPrice: 1,
            targetAccountId: 'active-target-account',
            allowedPaymentMethods: ['Vodafone Cash'],
        });
        const inactiveApp = await targetSvc.createTargetApp({
            name: 'Inactive App',
            unitPrice: 1,
            targetAccountId: 'inactive-target-account',
            allowedPaymentMethods: ['Vodafone Cash'],
        });

        await targetSvc.deactivateTargetApp(inactiveApp._id);

        const customerApps = await targetSvc.listTargetApps({ includeInactive: false });
        const adminApps = await targetSvc.listTargetApps({ includeInactive: true });

        expect(customerApps.map((app) => app._id.toString())).toEqual([activeApp._id.toString()]);
        expect(adminApps).toHaveLength(2);
    });

    test('keeps admin review compare-and-swap behavior', async () => {
        const { customer } = await createCustomerWithGroup();
        const admin = await createAdmin();
        const app = await targetSvc.createTargetApp({
            name: 'TikTok Coins',
            unitPrice: 1,
            targetAccountId: 'review-target-account',
            allowedPaymentMethods: ['Vodafone Cash'],
        });
        const order = await targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 10,
            senderId: 'sender-789',
            transferNumber: '01000000002',
            transactionNumber: 'txn-0002',
            paymentMethod: 'Vodafone Cash',
            screenshotProof: 'uploads/targets/proof.png',
        });

        await targetSvc.approveTargetOrder(order._id, admin._id, {
            adminPaymentProof: 'uploads/targets/admin-payment-proof.png',
        });
        await expect(targetSvc.rejectTargetOrder(order._id, admin._id)).rejects.toMatchObject({
            code: 'TARGET_ORDER_ALREADY_APPROVED',
        });

        const reviewed = await TargetOrder.findById(order._id);
        expect(reviewed.status).toBe(TARGET_ORDER_STATUS.APPROVED);
    });

    test('writes target approval/rejection audit logs with supervisor actor role', async () => {
        const { customer } = await createCustomerWithGroup();
        const supervisor = await createAdmin({ role: ACTOR_ROLES.SUPERVISOR });
        const app = await targetSvc.createTargetApp({
            name: 'Live Coins',
            unitPrice: 1.5,
            targetAccountId: 'audit-target-account',
            allowedPaymentMethods: ['Vodafone Cash'],
        });

        const approvalOrder = await targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 8,
            senderId: 'approve-1',
            transferNumber: '01000000003',
            transactionNumber: 'txn-0003',
            paymentMethod: 'Vodafone Cash',
            screenshotProof: 'uploads/targets/proof-approve.png',
        });

        await targetSvc.approveTargetOrder(
            approvalOrder._id,
            supervisor._id,
            {
                adminPaymentProof: 'uploads/targets/admin-payment-proof-audit.png',
                auditContext: { actorId: supervisor._id, actorRole: ACTOR_ROLES.SUPERVISOR },
            }
        );

        const rejectionOrder = await targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 6,
            senderId: 'reject-1',
            transferNumber: '01000000004',
            transactionNumber: 'txn-0004',
            paymentMethod: 'Vodafone Cash',
            screenshotProof: 'uploads/targets/proof-reject.png',
        });

        await targetSvc.rejectTargetOrder(
            rejectionOrder._id,
            supervisor._id,
            'Invalid transfer screenshot',
            { actorId: supervisor._id, actorRole: ACTOR_ROLES.SUPERVISOR }
        );

        await flushAudit();

        const [approveLog, rejectLog] = await Promise.all([
            AuditLog.findOne({
                action: TARGET_ORDER_ACTIONS.APPROVED,
                entityId: approvalOrder._id,
            }).lean(),
            AuditLog.findOne({
                action: TARGET_ORDER_ACTIONS.REJECTED,
                entityId: rejectionOrder._id,
            }).lean(),
        ]);

        expect(approveLog).not.toBeNull();
        expect(approveLog.actorId.toString()).toBe(supervisor._id.toString());
        expect(approveLog.actorRole).toBe(ACTOR_ROLES.SUPERVISOR);
        expect(approveLog.metadata.adminPaymentProofAttached).toBe(true);
        expect(approveLog.metadata.adminPaymentProof).toBe('uploads/targets/admin-payment-proof-audit.png');

        expect(rejectLog).not.toBeNull();
        expect(rejectLog.actorId.toString()).toBe(supervisor._id.toString());
        expect(rejectLog.actorRole).toBe(ACTOR_ROLES.SUPERVISOR);
    });

    test('requires separate admin payment proof, preserves customer proof, and records approval audit fields', async () => {
        const { customer } = await createCustomerWithGroup();
        const admin = await createAdmin();
        const app = await targetSvc.createTargetApp({
            name: 'Payment Proof App',
            unitPrice: 2,
            targetAccountId: 'payment-proof-target-account',
            allowedPaymentMethods: ['instapay'],
        });
        const order = await targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 5,
            senderId: 'proof-customer',
            transferNumber: '01000000011',
            transactionNumber: 'proof-txn-1',
            paymentMethod: 'InstaPay',
            screenshotProof: 'uploads/targets/customer-proof.png',
        });

        await expect(targetSvc.approveTargetOrder(order._id, admin._id)).rejects.toMatchObject({
            code: 'TARGET_ADMIN_PAYMENT_PROOF_REQUIRED',
        });
        await expect(TargetOrder.findById(order._id).then((saved) => saved.status)).resolves.toBe(TARGET_ORDER_STATUS.PENDING);

        const approved = await targetSvc.approveTargetOrder(order._id, admin._id, {
            adminPaymentProof: 'uploads/targets/admin-payment-proof.png',
            auditContext: { actorId: admin._id, actorRole: ACTOR_ROLES.ADMIN },
        });
        expect(approved.status).toBe(TARGET_ORDER_STATUS.APPROVED);
        expect(approved.screenshotProof).toBe('uploads/targets/customer-proof.png');
        expect(approved.adminPaymentProof).toBe('uploads/targets/admin-payment-proof.png');
        expect(approved.adminPaymentProofUploadedAt).toBeTruthy();
        expect(approved.adminPaymentProofUploadedBy._id.toString()).toBe(admin._id.toString());
        expect(approved.reviewedBy._id.toString()).toBe(admin._id.toString());
        expect(approved.reviewedAt).toBeTruthy();

        await expect(targetSvc.approveTargetOrder(order._id, admin._id, {
            adminPaymentProof: 'uploads/targets/replacement-proof.png',
        })).rejects.toMatchObject({ code: 'TARGET_ORDER_ALREADY_APPROVED' });
        await expect(TargetOrder.findById(order._id).then((saved) => saved.adminPaymentProof))
            .resolves.toBe('uploads/targets/admin-payment-proof.png');

        const mine = await targetSvc.listMyTargetOrders(customer._id);
        expect(mine.orders).toHaveLength(1);
        expect(mine.orders[0].adminPaymentProof).toBe('uploads/targets/admin-payment-proof.png');
        const { customer: otherCustomer } = await createCustomerWithGroup({ email: 'other-target-proof@example.com' });
        await expect(targetSvc.listMyTargetOrders(otherCustomer._id).then((result) => result.orders)).resolves.toEqual([]);

        await flushAudit();
        const audit = await AuditLog.findOne({ action: TARGET_ORDER_ACTIONS.APPROVED, entityId: order._id }).lean();
        expect(audit.metadata).toMatchObject({
            adminPaymentProofAttached: true,
            adminPaymentProof: 'uploads/targets/admin-payment-proof.png',
            reviewedBy: admin._id.toString(),
        });
    });

    test('does not allow rejected or generic status approval and preserves a legacy approved record without proof', async () => {
        const { customer } = await createCustomerWithGroup();
        const admin = await createAdmin();
        const app = await targetSvc.createTargetApp({
            name: 'Legacy Proof App',
            unitPrice: 1,
            targetAccountId: 'legacy-proof-target-account',
            allowedPaymentMethods: ['instapay'],
        });
        const rejected = await targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 2,
            senderId: 'rejected-customer',
            transferNumber: '01000000012',
            transactionNumber: 'rejected-txn',
            paymentMethod: 'InstaPay',
            screenshotProof: 'uploads/targets/rejected-customer-proof.png',
        });
        await targetSvc.rejectTargetOrder(rejected._id, admin._id, 'Invalid target transfer');
        await expect(targetSvc.approveTargetOrder(rejected._id, admin._id, {
            adminPaymentProof: 'uploads/targets/rejected-admin-proof.png',
        })).rejects.toMatchObject({ code: 'TARGET_ORDER_ALREADY_REJECTED' });

        const generic = await targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 3,
            senderId: 'generic-customer',
            transferNumber: '01000000013',
            transactionNumber: 'generic-txn',
            paymentMethod: 'InstaPay',
            screenshotProof: 'uploads/targets/generic-customer-proof.png',
        });
        for (const status of ['APPROVED', 'APPROVE', 'DONE']) {
            await expect(targetSvc.updateTargetOrderStatus(generic._id, status, admin._id))
                .rejects.toMatchObject({ code: 'TARGET_ADMIN_PAYMENT_PROOF_REQUIRED' });
        }

        const legacy = await TargetOrder.create({
            userId: customer._id,
            appId: app._id,
            appNameSnapshot: app.name,
            senderId: 'legacy-customer',
            paymentMethod: 'instapay',
            transferNumber: '01000000014',
            transactionNumber: 'legacy-txn',
            screenshotProof: 'uploads/targets/legacy-customer-proof.png',
            totalPrice: 4,
            unitPriceSnapshot: 1,
            coinAmount: 4,
            status: TARGET_ORDER_STATUS.APPROVED,
            reviewedBy: admin._id,
            reviewedAt: new Date(),
        });
        const listed = await targetSvc.listMyTargetOrders(customer._id);
        const legacyListed = listed.orders.find((item) => item._id.toString() === legacy._id.toString());
        expect(legacyListed.adminPaymentProof).toBeNull();
    });

    test('keeps compare-and-swap approval atomic when two valid proof submissions race', async () => {
        const { customer } = await createCustomerWithGroup();
        const admin = await createAdmin();
        const app = await targetSvc.createTargetApp({
            name: 'Concurrent Proof App',
            unitPrice: 1,
            targetAccountId: 'concurrent-proof-target-account',
            allowedPaymentMethods: ['instapay'],
        });
        const order = await targetSvc.createTargetOrder({
            userId: customer._id,
            appId: app._id,
            coinAmount: 1,
            senderId: 'concurrent-customer',
            transferNumber: '01000000015',
            transactionNumber: 'concurrent-txn',
            paymentMethod: 'InstaPay',
            screenshotProof: 'uploads/targets/concurrent-customer-proof.png',
        });
        const results = await Promise.allSettled([
            targetSvc.approveTargetOrder(order._id, admin._id, { adminPaymentProof: 'uploads/targets/race-proof-a.png' }),
            targetSvc.approveTargetOrder(order._id, admin._id, { adminPaymentProof: 'uploads/targets/race-proof-b.png' }),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        const stored = await TargetOrder.findById(order._id);
        expect(stored.status).toBe(TARGET_ORDER_STATUS.APPROVED);
        expect(['uploads/targets/race-proof-a.png', 'uploads/targets/race-proof-b.png']).toContain(stored.adminPaymentProof);
    });

    test('rejects a spoofed admin payment proof image signature before approval', async () => {
        await expect(validateUploadedFileSignature({
            mimetype: 'image/png',
            buffer: Buffer.from('not a PNG image'),
        }, {
            code: 'TARGET_ADMIN_PAYMENT_PROOF_INVALID',
            message: 'Admin payment proof file is invalid.',
        })).rejects.toMatchObject({ code: 'TARGET_ADMIN_PAYMENT_PROOF_INVALID' });
    });
});
