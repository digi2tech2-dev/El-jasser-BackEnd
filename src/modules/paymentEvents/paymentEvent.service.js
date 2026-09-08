'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../../config/config');
const { Decimal } = require('../../shared/utils/decimalPrecision');
const { DepositRequest, DEPOSIT_STATUS } = require('../deposits/deposit.model');
const {
    PaymentEvent,
    PAYMENT_EVENT_PROVIDER,
    PAYMENT_EVENT_MATCH_STATUS,
} = require('./paymentEvent.model');
const { parsePaymentSms, normalizePhone } = require('./paymentEvent.parser');

const SYSTEM_ACTOR_ID = new mongoose.Types.ObjectId('000000000000000000000001');

const normalizeSmsSender = (value) => String(value || '')
    .trim().toLowerCase().replace(/[\s_-]+/g, '');

const isTrustedSmsSender = (value) => normalizeSmsSender(value) === 'vfcash';

const createDeliveryFingerprint = ({ bridgeId, smsSender, receivedStamp, rawMessage }) => crypto
    .createHash('sha256')
    .update([bridgeId, smsSender, receivedStamp || '', rawMessage].join('\u0000'), 'utf8')
    .digest('hex');

const toSafeSmsDate = (value, fieldName) => {
    if (value === undefined || value === null || value === '' || Number(value) === 0) return null;
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric < 946684800000) {
        const error = new Error(`${fieldName} is invalid.`);
        error.code = 'INVALID_SMS_TIMESTAMP';
        throw error;
    }
    const milliseconds = numeric < 100000000000 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    if (Number.isNaN(date.getTime()) || date.getTime() > Date.now() + (5 * 60 * 1000)) {
        const error = new Error(`${fieldName} is invalid.`);
        error.code = 'INVALID_SMS_TIMESTAMP';
        throw error;
    }
    return date;
};

const sameAmount = (left, right) => {
    try {
        return new Decimal(left).eq(new Decimal(right));
    } catch (_) {
        return false;
    }
};

const normalizePaymentMethod = (value) => String(value || '')
    .toLowerCase().replace(/[\s_-]+/g, '');

const isVodafoneCashMethod = (value) => {
    const normalized = normalizePaymentMethod(value);
    return normalized === 'vodafone'
        || normalized === 'vodafonecash'
        || normalized === 'vfcash'
        || normalized.includes('vodafonecash')
        || normalized.includes('vfcash');
};

// transactionId is the canonical customer-facing deposit reference. The
// legacy field and explicitly labelled notes are read only for old deposits.
const extractDepositTransactionId = (deposit) => {
    if (deposit.transactionId) return String(deposit.transactionId).trim();
    if (deposit.paymentTransactionId) return String(deposit.paymentTransactionId).trim();
    const noteMatch = String(deposit.notes || '').match(/(?:transaction\s*(?:id|number)|رقم\s*العملية|رقم\s*التحويل)\s*[:：#-]?\s*([0-9]{8,20})/iu);
    return noteMatch ? noteMatch[1] : null;
};

const getDepositSenderPhone = (deposit) => normalizePhone(deposit?.senderDetails?.value);

const persistEvent = async ({ bridgeId, payload, smsSentAt, smsReceivedAt }) => {
    const rawMessage = String(payload.text || '');
    const parsed = parsePaymentSms(rawMessage);
    const deliveryFingerprint = createDeliveryFingerprint({
        bridgeId,
        smsSender: payload.from,
        receivedStamp: payload.receivedStamp,
        rawMessage,
    });

    const document = {
        provider: PAYMENT_EVENT_PROVIDER,
        sourceType: parsed.sourceType,
        bridgeId,
        smsSender: String(payload.from).trim(),
        transactionId: parsed.transactionId || null,
        amount: parsed.amount || null,
        currency: 'EGP',
        senderPhone: parsed.senderPhone || null,
        smsSentAt,
        smsReceivedAt,
        rawMessage,
        rawPayload: payload,
        deliveryFingerprint,
        parseStatus: parsed.parseStatus,
        matchStatus: PAYMENT_EVENT_MATCH_STATUS.UNMATCHED,
        errorCode: parsed.parseStatus === 'FAILED' ? 'UNSUPPORTED_PAYMENT_FORMAT' : null,
        errorMessage: parsed.parseStatus === 'FAILED' ? 'Incoming payment SMS was not in a supported format.' : null,
    };

    try {
        const event = await PaymentEvent.create(document);
        return { event, duplicate: false };
    } catch (error) {
        if (error?.code !== 11000) throw error;
        const event = await PaymentEvent.findOne({
            $or: [
                { deliveryFingerprint },
                ...(parsed.parseStatus === 'PARSED'
                    ? [{ provider: PAYMENT_EVENT_PROVIDER, sourceType: parsed.sourceType, transactionId: parsed.transactionId }]
                    : []),
            ],
        });
        if (event) return { event, duplicate: true };
        throw error;
    }
};

const eventIsWithinAutoApprovalAge = (event) => {
    const at = event.smsReceivedAt || event.smsSentAt || event.serverReceivedAt;
    return Date.now() - new Date(at).getTime() <= config.vodafoneSmsBridge.maxEventAgeMinutes * 60 * 1000;
};

const maybeAutoApprove = async (event) => {
    if (!config.vodafoneSmsBridge.autoApprove || event.matchStatus !== PAYMENT_EVENT_MATCH_STATUS.MATCHED) return false;
    if (event.sourceType === 'INSTAPAY' && !config.vodafoneSmsBridge.instaPayAutoApprove) return false;
    if (event.sourceType !== 'VODAFONE_WALLET' && event.sourceType !== 'INSTAPAY') return false;
    if (!eventIsWithinAutoApprovalAge(event)) return false;

    const depositService = require('../deposits/deposit.service');
    let approved;
    try {
        approved = await depositService.approveDeposit(
            event.matchedDepositId,
            SYSTEM_ACTOR_ID,
            { reviewSource: 'VODAFONE_SMS_AUTO', paymentEventId: event._id, autoVerifiedAt: new Date() },
            { actorId: SYSTEM_ACTOR_ID, actorRole: 'SYSTEM' }
        );
    } catch (error) {
        // A duplicate delivery or the post-deposit reconciliation can race the
        // first auto-approval attempt. The canonical deposit CAS has already
        // prevented another wallet mutation; treat only the same-event result
        // as an idempotent success.
        if (error?.code !== 'DEPOSIT_ALREADY_APPROVED') throw error;
        const deposit = await DepositRequest.findById(event.matchedDepositId)
            .select('paymentEventId reviewSource');
        if (!deposit || String(deposit.paymentEventId || '') !== String(event._id)
            || deposit.reviewSource !== 'VODAFONE_SMS_AUTO') {
            throw error;
        }
        approved = deposit;
    }

    await PaymentEvent.updateOne(
        { _id: event._id, matchStatus: PAYMENT_EVENT_MATCH_STATUS.MATCHED },
        { $set: { matchStatus: PAYMENT_EVENT_MATCH_STATUS.PROCESSED, processedAt: new Date() } }
    );
    return Boolean(approved);
};

const matchPaymentEvent = async (eventId) => {
    const event = await PaymentEvent.findById(eventId);
    if (!event || event.parseStatus !== 'PARSED' || event.matchStatus === PAYMENT_EVENT_MATCH_STATUS.PROCESSED) return event;

    const deposits = await DepositRequest.find({
        status: DEPOSIT_STATUS.PENDING,
        currency: { $in: ['EGP', 'EGY'] },
    });
    const methodCandidates = deposits.filter((deposit) => isVodafoneCashMethod(deposit.paymentMethodId));
    const transactionCandidates = methodCandidates.filter((deposit) => extractDepositTransactionId(deposit) === event.transactionId);
    const amountCandidates = transactionCandidates.filter((deposit) => sameAmount(deposit.requestedAmount, event.amount));

    let matchStatus = PAYMENT_EVENT_MATCH_STATUS.UNMATCHED;
    let matchedDeposit = null;
    if (transactionCandidates.length && !amountCandidates.length) {
        matchStatus = PAYMENT_EVENT_MATCH_STATUS.MISMATCH;
    } else {
        const phoneCompatible = amountCandidates.filter((deposit) => {
            const depositPhone = getDepositSenderPhone(deposit);
            return !depositPhone || depositPhone === event.senderPhone;
        });
        if (amountCandidates.length && !phoneCompatible.length) {
            matchStatus = PAYMENT_EVENT_MATCH_STATUS.MISMATCH;
        } else if (phoneCompatible.length > 1) {
            matchStatus = PAYMENT_EVENT_MATCH_STATUS.AMBIGUOUS;
        } else if (phoneCompatible.length === 1) {
            matchStatus = PAYMENT_EVENT_MATCH_STATUS.MATCHED;
            matchedDeposit = phoneCompatible[0];
        }
    }

    const update = {
        matchStatus,
        matchedDepositId: matchedDeposit?._id || null,
        matchedUserId: matchedDeposit?.userId || null,
    };
    const updated = await PaymentEvent.findByIdAndUpdate(event._id, { $set: update }, { new: true });

    if (updated.matchStatus === PAYMENT_EVENT_MATCH_STATUS.MATCHED) {
        await maybeAutoApprove(updated);
        return PaymentEvent.findById(updated._id);
    }
    return updated;
};

const matchUnmatchedEventsForDeposit = async (depositId) => {
    const deposit = await DepositRequest.findById(depositId).select('status currency paymentMethodId');
    if (!deposit || deposit.status !== DEPOSIT_STATUS.PENDING || !['EGP', 'EGY'].includes(deposit.currency) || !isVodafoneCashMethod(deposit.paymentMethodId)) return [];
    const events = await PaymentEvent.find({
        parseStatus: 'PARSED',
        matchStatus: { $in: [PAYMENT_EVENT_MATCH_STATUS.UNMATCHED, PAYMENT_EVENT_MATCH_STATUS.MISMATCH, PAYMENT_EVENT_MATCH_STATUS.AMBIGUOUS] },
    }).select('_id');
    return Promise.all(events.map((event) => matchPaymentEvent(event._id)));
};

module.exports = {
    isTrustedSmsSender,
    toSafeSmsDate,
    persistEvent,
    matchPaymentEvent,
    matchUnmatchedEventsForDeposit,
    maybeAutoApprove,
    createDeliveryFingerprint,
    extractDepositTransactionId,
};
