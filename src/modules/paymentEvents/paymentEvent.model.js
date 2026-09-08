'use strict';

const mongoose = require('mongoose');
const { PAYMENT_EVENT_SOURCE_TYPES } = require('./paymentEvent.parser');

const PAYMENT_EVENT_PROVIDER = 'VODAFONE_CASH';
const PAYMENT_EVENT_PARSE_STATUS = Object.freeze({ PARSED: 'PARSED', IGNORED: 'IGNORED', FAILED: 'FAILED' });
const PAYMENT_EVENT_MATCH_STATUS = Object.freeze({
    UNMATCHED: 'UNMATCHED', MATCHED: 'MATCHED', AMBIGUOUS: 'AMBIGUOUS', MISMATCH: 'MISMATCH', PROCESSED: 'PROCESSED',
});

const paymentEventSchema = new mongoose.Schema({
    provider: { type: String, required: true, default: PAYMENT_EVENT_PROVIDER, index: true },
    sourceType: { type: String, required: true, enum: Object.values(PAYMENT_EVENT_SOURCE_TYPES), index: true },
    bridgeId: { type: String, required: true, trim: true, maxlength: 128, index: true },
    smsSender: { type: String, required: true, trim: true, maxlength: 128 },
    transactionId: { type: String, trim: true, maxlength: 64, default: null },
    amount: { type: String, trim: true, maxlength: 32, default: null },
    currency: { type: String, default: 'EGP', uppercase: true, trim: true },
    senderPhone: { type: String, trim: true, maxlength: 16, default: null },
    smsSentAt: { type: Date, default: null },
    smsReceivedAt: { type: Date, default: null },
    serverReceivedAt: { type: Date, required: true, default: Date.now },
    rawMessage: { type: String, required: true, maxlength: 5000 },
    rawPayload: { type: mongoose.Schema.Types.Mixed, required: true },
    deliveryFingerprint: { type: String, required: true, trim: true, maxlength: 128 },
    parseStatus: { type: String, required: true, enum: Object.values(PAYMENT_EVENT_PARSE_STATUS), index: true },
    matchStatus: { type: String, required: true, enum: Object.values(PAYMENT_EVENT_MATCH_STATUS), default: PAYMENT_EVENT_MATCH_STATUS.UNMATCHED, index: true },
    matchedDepositId: { type: mongoose.Schema.Types.ObjectId, ref: 'DepositRequest', default: null, index: true },
    matchedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    processedAt: { type: Date, default: null },
    errorCode: { type: String, default: null, maxlength: 128 },
    errorMessage: { type: String, default: null, maxlength: 256 },
}, { timestamps: true, versionKey: false });

// Parsed financial notifications are globally idempotent by provider, source
// format, and the provider's string transaction reference. Non-parsable SMSes
// fall back to a delivery fingerprint so Android retries cannot flood storage.
paymentEventSchema.index(
    { provider: 1, sourceType: 1, transactionId: 1 },
    { unique: true, partialFilterExpression: { parseStatus: 'PARSED', transactionId: { $type: 'string' } }, name: 'unique_parsed_payment_event_transaction' }
);
paymentEventSchema.index({ deliveryFingerprint: 1 }, { unique: true, name: 'unique_payment_event_delivery' });
paymentEventSchema.index({ parseStatus: 1, matchStatus: 1, createdAt: -1 });

const PaymentEvent = mongoose.model('PaymentEvent', paymentEventSchema);

module.exports = { PaymentEvent, PAYMENT_EVENT_PROVIDER, PAYMENT_EVENT_PARSE_STATUS, PAYMENT_EVENT_MATCH_STATUS };
