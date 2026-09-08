'use strict';

const crypto = require('crypto');
const config = require('../../config/config');
const { AppError } = require('../../shared/errors/AppError');
const catchAsync = require('../../shared/utils/catchAsync');
const service = require('./paymentEvent.service');

const signatureMatches = (rawBody, suppliedSignature, secret) => {
    if (!Buffer.isBuffer(rawBody) || !suppliedSignature || !secret) return false;
    const received = String(suppliedSignature).trim().replace(/^sha256=/i, '');
    if (!/^[a-f0-9]{64}$/i.test(received)) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
};

const validatePayload = (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new AppError('Invalid SMS bridge payload.', 400, 'INVALID_PAYMENT_EVENT');
    }
    if (typeof payload.from !== 'string' || typeof payload.text !== 'string' || !payload.text.trim()) {
        throw new AppError('Invalid SMS bridge payload.', 400, 'INVALID_PAYMENT_EVENT');
    }
    if (payload.from.length > 128 || payload.text.length > 5000) {
        throw new AppError('Invalid SMS bridge payload.', 400, 'INVALID_PAYMENT_EVENT');
    }
    if (!service.isTrustedSmsSender(payload.from)) {
        throw new AppError('Untrusted SMS sender.', 400, 'INVALID_SMS_SENDER');
    }
};

const receiveVodafoneCashEvent = catchAsync(async (req, res) => {
    const bridge = config.vodafoneSmsBridge;
    if (!bridge.enabled) {
        throw new AppError('Payment event bridge is disabled.', 503, 'PAYMENT_EVENT_BRIDGE_DISABLED');
    }
    if (!bridge.hmacSecret) {
        throw new AppError('Payment event bridge is unavailable.', 503, 'PAYMENT_EVENT_BRIDGE_UNCONFIGURED');
    }
    const bridgeId = String(req.get('X-Bridge-Id') || '').trim();
    if (!bridgeId || bridgeId !== bridge.deviceId) {
        throw new AppError('Bridge authentication failed.', 401, 'INVALID_BRIDGE_ID');
    }
    if (!signatureMatches(req.rawBody, req.get('X-Signature'), bridge.hmacSecret)) {
        throw new AppError('Bridge authentication failed.', 401, 'INVALID_BRIDGE_SIGNATURE');
    }

    validatePayload(req.body);
    let smsSentAt;
    let smsReceivedAt;
    try {
        smsSentAt = service.toSafeSmsDate(req.body.sentStamp, 'sentStamp');
        smsReceivedAt = service.toSafeSmsDate(req.body.receivedStamp, 'receivedStamp');
    } catch (error) {
        throw new AppError('Invalid SMS timestamp.', 400, error.code || 'INVALID_SMS_TIMESTAMP');
    }

    const persisted = await service.persistEvent({ bridgeId, payload: req.body, smsSentAt, smsReceivedAt });
    if (persisted.duplicate) return res.status(200).json({ success: true, duplicate: true });

    const event = await service.matchPaymentEvent(persisted.event._id);
    return res.status(201).json({
        success: true,
        duplicate: false,
        parsed: event.parseStatus === 'PARSED',
        sourceType: event.sourceType,
        matched: ['MATCHED', 'PROCESSED'].includes(event.matchStatus),
        autoApproved: event.matchStatus === 'PROCESSED',
    });
});

module.exports = { receiveVodafoneCashEvent, signatureMatches };
