'use strict';

const { DevicePushToken } = require('../modules/devices/devicePushToken.model');
const {
    registerAndroidPushToken,
    unregisterAndroidPushToken,
} = require('../modules/devices/devicePush.service');
const { sendNotificationToUser } = require('../services/firebasePush.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
} = require('./testHelpers');

const token = (suffix) => `fcm-test-token-${suffix}-abcdefghijklmnopqrstuvwxyz`;

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
});

describe('Android push-device registration', () => {
    it('deduplicates a token and transfers it to the currently authenticated user', async () => {
        const { customer: first } = await createCustomerWithGroup();
        const { customer: second } = await createCustomerWithGroup();
        const sharedToken = token('shared');

        await registerAndroidPushToken({ userId: first._id, token: sharedToken, platform: 'android' });
        await registerAndroidPushToken({ userId: second._id, token: sharedToken, platform: 'android' });

        const devices = await DevicePushToken.find({}).select('+token');
        expect(devices).toHaveLength(1);
        expect(devices[0].userId.toString()).toBe(second._id.toString());
        expect(devices[0].isActive).toBe(true);
    });

    it('supports multiple active devices for one user and unregisters only the current token', async () => {
        const { customer } = await createCustomerWithGroup();
        const firstToken = token('one');
        const secondToken = token('two');
        await registerAndroidPushToken({ userId: customer._id, token: firstToken, platform: 'android' });
        await registerAndroidPushToken({ userId: customer._id, token: secondToken, platform: 'android' });

        await unregisterAndroidPushToken({ userId: customer._id, token: firstToken });

        const devices = await DevicePushToken.find({}).select('+token').sort({ token: 1 });
        expect(devices).toHaveLength(2);
        expect(devices.find((device) => device.token === firstToken).isActive).toBe(false);
        expect(devices.find((device) => device.token === secondToken).isActive).toBe(true);
    });

    it('rejects malformed tokens and unsupported platforms', async () => {
        const { customer } = await createCustomerWithGroup();
        await expect(registerAndroidPushToken({ userId: customer._id, token: 'short', platform: 'android' }))
            .rejects.toMatchObject({ code: 'PUSH_TOKEN_INVALID' });
        await expect(registerAndroidPushToken({ userId: customer._id, token: token('ios'), platform: 'ios' }))
            .rejects.toMatchObject({ code: 'PUSH_PLATFORM_INVALID' });
    });

    it('keeps operating when Firebase is not configured', async () => {
        await expect(sendNotificationToUser({
            userId: '507f1f77bcf86cd799439011',
            notification: { title: 'Test', message: 'Test' },
        })).resolves.toBeUndefined();
    });
});
