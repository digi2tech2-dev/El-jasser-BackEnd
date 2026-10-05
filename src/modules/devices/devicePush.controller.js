'use strict';

const catchAsync = require('../../shared/utils/catchAsync');
const { sendSuccess } = require('../../shared/utils/apiResponse');
const devicePushService = require('./devicePush.service');

const register = catchAsync(async (req, res) => {
    await devicePushService.registerAndroidPushToken({
        userId: req.user._id,
        token: req.body.token,
        platform: req.body.platform,
    });
    sendSuccess(res, null, 'Push notifications registered.');
});

const unregister = catchAsync(async (req, res) => {
    await devicePushService.unregisterAndroidPushToken({
        userId: req.user._id,
        token: req.body.token,
    });
    sendSuccess(res, null, 'Push notifications unregistered.');
});

module.exports = { register, unregister };
