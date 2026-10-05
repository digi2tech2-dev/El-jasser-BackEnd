'use strict';

const config = require('../config/config');
const { DevicePushToken } = require('../modules/devices/devicePushToken.model');

const INVALID_TOKEN_CODES = new Set([
    'messaging/invalid-registration-token',
    'messaging/registration-token-not-registered',
]);
const FCM_MULTICAST_LIMIT = 500;
let firebaseApp = null;
let configWarningLogged = false;

const getFirebaseApp = () => {
    if (firebaseApp) return firebaseApp;

    const { projectId, clientEmail, privateKey } = config.firebase;
    if (!projectId || !clientEmail || !privateKey) {
        if (!configWarningLogged) {
            configWarningLogged = true;
            console.warn('[Push] Firebase is not configured; Android push delivery is disabled.');
        }
        return null;
    }

    try {
        const admin = require('firebase-admin');
        firebaseApp = admin.apps.length
            ? admin.app()
            : admin.initializeApp({
                credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
            });
        return firebaseApp;
    } catch (err) {
        if (!configWarningLogged) {
            configWarningLogged = true;
            console.warn(`[Push] Firebase initialization failed; Android push delivery is disabled: ${err.message}`);
        }
        return null;
    }
};

const isSafeInternalRoute = (route) => (
    typeof route === 'string'
    && route.startsWith('/')
    && !route.startsWith('//')
    && !route.includes('://')
    && !route.includes('\\')
);

const disableInvalidTokens = async (tokens) => {
    if (!tokens.length) return;
    await DevicePushToken.updateMany(
        { token: { $in: tokens } },
        { $set: { isActive: false } }
    );
};

const normalizeUserIds = (userIds) => {
    const unique = new Map();
    for (const userId of userIds || []) {
        if (userId === undefined || userId === null) continue;
        const key = userId.toString();
        if (key) unique.set(key, userId);
    }
    return [...unique.values()];
};

const buildMessage = (tokens, notification) => ({
    tokens,
    notification: {
        title: String(notification.title || 'El-Jasser'),
        body: String(notification.message || ''),
    },
    data: {
        notificationId: String(notification._id || ''),
        type: String(notification.type || ''),
        route: isSafeInternalRoute(notification.link) ? notification.link : '',
    },
    android: {
        priority: 'high',
        notification: {
            channelId: 'eljasser_general',
            sound: 'default',
        },
    },
});

/**
 * Deliver one persisted notification to many recipient users efficiently.
 * Device lookup is performed once for the unique recipient set; FCM batches
 * are limited to Firebase's 500-token multicast maximum.
 */
const sendNotificationToUsers = async ({ userIds, notification }) => {
    const app = getFirebaseApp();
    const recipients = normalizeUserIds(userIds);
    if (!app || !recipients.length || !notification) return;

    try {
        const devices = await DevicePushToken.find({
            userId: { $in: recipients },
            platform: 'android',
            appId: 'com.eljasser.app',
            isActive: true,
        }).select('+token').lean();
        const tokens = [...new Set(devices.map((device) => device.token).filter(Boolean))];

        for (let offset = 0; offset < tokens.length; offset += FCM_MULTICAST_LIMIT) {
            const batch = tokens.slice(offset, offset + FCM_MULTICAST_LIMIT);
            try {
                const response = await app.messaging().sendEachForMulticast(buildMessage(batch, notification));
                const invalidTokens = response.responses
                    .map((result, index) => (result.success || !INVALID_TOKEN_CODES.has(result.error?.code) ? null : batch[index]))
                    .filter(Boolean);
                await disableInvalidTokens(invalidTokens);
            } catch (err) {
                // This is intentionally isolated from notification persistence.
                console.error(`[Push] FCM delivery failed: ${err.message}`);
            }
        }
    } catch (err) {
        // Device lookup and token cleanup must be just as non-fatal as FCM.
        console.error(`[Push] Unable to resolve Android devices: ${err.message}`);
    }
};

const sendNotificationToUser = ({ userId, notification }) =>
    sendNotificationToUsers({ userIds: [userId], notification });

module.exports = {
    sendNotificationToUser,
    sendNotificationToUsers,
    FCM_MULTICAST_LIMIT,
};
