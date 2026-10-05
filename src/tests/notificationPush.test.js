'use strict';

const mockSendNotificationToUser = jest.fn();
const mockSendNotificationToUsers = jest.fn();
jest.mock('../services/firebasePush.service', () => ({
    sendNotificationToUser: mockSendNotificationToUser,
    sendNotificationToUsers: mockSendNotificationToUsers,
}));

const { Notification } = require('../modules/notifications/notification.model');
const notificationService = require('../modules/notifications/notification.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createAdmin,
    createCustomer,
    createCustomerWithGroup,
    ROLES,
    USER_STATUS,
} = require('./testHelpers');

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

beforeAll(async () => {
    await connectTestDB();
});

afterAll(async () => {
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
    mockSendNotificationToUser.mockReset().mockResolvedValue();
    mockSendNotificationToUsers.mockReset().mockResolvedValue();
});

describe('notification persistence and Android push dispatch', () => {
    it('persists a notifyUser notification and dispatches one user push', async () => {
        const { customer } = await createCustomerWithGroup();
        await notificationService.notifyUser({ userId: customer._id, title: 'One', message: 'Body' });

        expect(await Notification.countDocuments({ userId: customer._id })).toBe(1);
        expect(mockSendNotificationToUser).toHaveBeenCalledWith(expect.objectContaining({ userId: customer._id }));
    });

    it('persists group notifications once per recipient and dispatches one batched user set', async () => {
        const { customer: first, group } = await createCustomerWithGroup();
        const second = await createCustomer({ groupId: group._id });

        await notificationService.notifyGroup(group._id, { title: 'Group', message: 'Body' });

        expect(await Notification.countDocuments({ title: 'Group' })).toBe(2);
        expect(mockSendNotificationToUsers).toHaveBeenCalledWith(expect.objectContaining({
            userIds: expect.arrayContaining([first._id, second._id]),
            notification: expect.objectContaining({ title: 'Group' }),
        }));
    });

    it('dispatches admin/supervisor notifications only to the persisted review recipients', async () => {
        const admin = await createAdmin();
        const supervisor = await createAdmin({ role: ROLES.SUPERVISOR });
        await createCustomerWithGroup();

        await notificationService.notifyNewDeposit({ requestedAmount: 10, currency: 'USD', userNameSnapshot: 'Customer' });

        expect(await Notification.countDocuments({ title: 'New Deposit Request' })).toBe(2);
        expect(mockSendNotificationToUsers).toHaveBeenCalledWith(expect.objectContaining({
            userIds: expect.arrayContaining([admin._id, supervisor._id]),
        }));
    });

    it('dispatches an admin single-user notification after its one DB row persists', async () => {
        const { customer } = await createCustomerWithGroup();
        const result = await notificationService.adminSendNotification({
            userId: customer._id,
            title: 'Manual',
            message: 'Body',
        });

        expect(result.mode).toBe('user');
        expect(await Notification.countDocuments({ title: 'Manual' })).toBe(1);
        expect(mockSendNotificationToUser).toHaveBeenCalledWith(expect.objectContaining({ userId: customer._id }));
    });

    it('keeps one broadcast DB row and pushes only the active inbox audience', async () => {
        const { customer: activeCustomer } = await createCustomerWithGroup();
        const admin = await createAdmin();
        const { customer: pendingCustomer } = await createCustomerWithGroup({ status: USER_STATUS.PENDING });

        const result = await notificationService.adminSendNotification({
            broadcast: true,
            title: 'Broadcast',
            message: 'Body',
        });
        await flushAsync();
        await flushAsync();

        expect(result.mode).toBe('broadcast');
        expect(await Notification.countDocuments({ title: 'Broadcast' })).toBe(1);
        expect(mockSendNotificationToUsers).toHaveBeenCalledWith(expect.objectContaining({
            userIds: expect.arrayContaining([activeCustomer._id, admin._id]),
        }));
        const pushedUserIds = mockSendNotificationToUsers.mock.calls[0][0].userIds.map(String);
        expect(pushedUserIds).not.toContain(pendingCustomer._id.toString());
    });

    it('applies the same active audience rule to notifyBroadcast without per-user DB rows', async () => {
        const { customer: activeCustomer } = await createCustomerWithGroup();
        const { customer: rejectedCustomer } = await createCustomerWithGroup({ status: USER_STATUS.REJECTED });

        await notificationService.notifyBroadcast({ title: 'System', message: 'Body' });
        await flushAsync();
        await flushAsync();

        expect(await Notification.countDocuments({ title: 'System' })).toBe(1);
        const pushedUserIds = mockSendNotificationToUsers.mock.calls[0][0].userIds.map(String);
        expect(pushedUserIds).toContain(activeCustomer._id.toString());
        expect(pushedUserIds).not.toContain(rejectedCustomer._id.toString());
    });

    it('does not roll back persistence when FCM dispatch fails', async () => {
        const { customer } = await createCustomerWithGroup();
        mockSendNotificationToUser.mockRejectedValueOnce(new Error('FCM unavailable'));

        await expect(notificationService.notifyUser({ userId: customer._id, title: 'Resilient', message: 'Body' }))
            .resolves.toBeTruthy();
        expect(await Notification.countDocuments({ title: 'Resilient' })).toBe(1);
    });
});
