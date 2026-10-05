'use strict';

const mockSendEachForMulticast = jest.fn();
jest.mock('firebase-admin', () => ({
    apps: [],
    credential: { cert: jest.fn(() => ({})) },
    initializeApp: jest.fn(() => ({
        messaging: () => ({ sendEachForMulticast: mockSendEachForMulticast }),
    })),
}));

const config = require('../config/config');
const { DevicePushToken } = require('../modules/devices/devicePushToken.model');
const {
    sendNotificationToUser,
    sendNotificationToUsers,
} = require('../services/firebasePush.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createCustomerWithGroup,
} = require('./testHelpers');

beforeAll(async () => {
    config.firebase.projectId = 'test-project';
    config.firebase.clientEmail = 'firebase@test.invalid';
    config.firebase.privateKey = 'test-private-key';
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
    mockSendEachForMulticast.mockReset();
    mockSendEachForMulticast.mockImplementation(({ tokens }) => Promise.resolve({
        responses: tokens.map(() => ({ success: true })),
    }));
});

it('deduplicates recipient IDs/tokens and splits more than 500 tokens into multicast batches', async () => {
    const { customer } = await createCustomerWithGroup();
    const devices = Array.from({ length: 501 }, (_, index) => ({
        userId: customer._id,
        token: `batch-token-${index}-abcdefghijklmnopqrstuvwxyz`,
        platform: 'android',
        appId: 'com.eljasser.app',
    }));
    await DevicePushToken.insertMany(devices);

    await sendNotificationToUsers({
        userIds: [customer._id, customer._id],
        notification: { title: 'Batch', message: 'Body' },
    });

    expect(mockSendEachForMulticast).toHaveBeenCalledTimes(2);
    expect(mockSendEachForMulticast.mock.calls.map(([message]) => message.tokens.length)).toEqual([500, 1]);
    const deliveredTokens = mockSendEachForMulticast.mock.calls.flatMap(([message]) => message.tokens);
    expect(new Set(deliveredTokens).size).toBe(501);
});

it('deactivates permanently invalid FCM tokens without failing notification delivery', async () => {
    const { customer } = await createCustomerWithGroup();
    await DevicePushToken.create({
        userId: customer._id,
        token: 'invalid-fcm-token-abcdefghijklmnopqrstuvwxyz',
        platform: 'android',
        appId: 'com.eljasser.app',
    });
    mockSendEachForMulticast.mockResolvedValue({
        responses: [{ success: false, error: { code: 'messaging/registration-token-not-registered' } }],
    });

    await expect(sendNotificationToUser({
        userId: customer._id,
        notification: { _id: customer._id, title: 'Order update', message: 'Completed', link: '/orders' },
    })).resolves.toBeUndefined();

    expect(mockSendEachForMulticast).toHaveBeenCalledWith(expect.objectContaining({
        notification: { title: 'Order update', body: 'Completed' },
        data: expect.objectContaining({ route: '/orders' }),
    }));
    const device = await DevicePushToken.findOne({ userId: customer._id });
    expect(device.isActive).toBe(false);
});
