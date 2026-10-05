'use strict';

const { DevicePushToken } = require('./devicePushToken.model');
const { AppError } = require('../../shared/errors/AppError');

const ANDROID_APP_ID = 'com.eljasser.app';
const MIN_TOKEN_LENGTH = 20;
const MAX_TOKEN_LENGTH = 4096;

const normalizeToken = (token) => String(token || '').trim();

const assertValidToken = (token) => {
    if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
        throw new AppError('A valid push registration token is required.', 400, 'PUSH_TOKEN_INVALID');
    }
};

const registerAndroidPushToken = async ({ userId, token, platform }) => {
    const normalizedToken = normalizeToken(token);
    assertValidToken(normalizedToken);

    if (platform !== 'android') {
        throw new AppError('Only Android push registration is supported.', 400, 'PUSH_PLATFORM_INVALID');
    }

    // token is globally unique: this atomic upsert safely transfers a device
    // from a prior account instead of leaving it subscribed to both accounts.
    await DevicePushToken.findOneAndUpdate(
        { token: normalizedToken },
        {
            $set: {
                userId,
                platform: 'android',
                appId: ANDROID_APP_ID,
                isActive: true,
                lastSeenAt: new Date(),
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
};

const unregisterAndroidPushToken = async ({ userId, token }) => {
    const normalizedToken = normalizeToken(token);
    assertValidToken(normalizedToken);

    // Scope by owner: a caller cannot disable another account's device.
    await DevicePushToken.updateOne(
        { userId, token: normalizedToken },
        { $set: { isActive: false, lastSeenAt: new Date() } }
    );
};

module.exports = {
    registerAndroidPushToken,
    unregisterAndroidPushToken,
};
