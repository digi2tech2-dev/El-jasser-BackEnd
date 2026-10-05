'use strict';

const mongoose = require('mongoose');

const devicePushTokenSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    // Registration tokens identify a physical app installation. Keep them out
    // of normal query results and never return them from an API response.
    token: {
        type: String,
        required: true,
        unique: true,
        select: false,
    },
    platform: {
        type: String,
        enum: ['android'],
        required: true,
        default: 'android',
    },
    appId: {
        type: String,
        required: true,
        default: 'com.eljasser.app',
    },
    isActive: {
        type: Boolean,
        default: true,
        index: true,
    },
    lastSeenAt: {
        type: Date,
        default: Date.now,
    },
}, { timestamps: true });

devicePushTokenSchema.index({ userId: 1, isActive: 1 });

const DevicePushToken = mongoose.model('DevicePushToken', devicePushTokenSchema);

module.exports = { DevicePushToken };
