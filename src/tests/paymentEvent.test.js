'use strict';

const crypto = require('crypto');
const http = require('http');
const config = require('../config/config');
const { PaymentEvent } = require('../modules/paymentEvents/paymentEvent.model');
const paymentEventService = require('../modules/paymentEvents/paymentEvent.service');
const { parsePaymentSms } = require('../modules/paymentEvents/paymentEvent.parser');
const depositService = require('../modules/deposits/deposit.service');
const { DepositRequest, DEPOSIT_STATUS } = require('../modules/deposits/deposit.model');
const { User } = require('../modules/users/user.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { Setting } = require('../modules/admin/setting.model');
const { invalidateSettingsCache } = require('../modules/admin/admin.settings.service');
const {
    connectTestDB, disconnectTestDB, clearCollections, createCustomerWithGroup,
} = require('./testHelpers');

let app;
let server;
let baseUrl;
const bridgeConfig = config.vodafoneSmsBridge;

const walletSms = (overrides = {}) => ({
    from: 'VF-Cash',
    text: 'تم استلام مبلغ 500 جنيه من رقم 01012572681. تاريخ العملية: اليوم. رقم العملية: 022494991382',
    sentStamp: Date.now(),
    receivedStamp: Date.now(),
    sim: '0',
    ...overrides,
});

const sign = (body, secret = bridgeConfig.hmacSecret) => crypto
    .createHmac('sha256', secret).update(body).digest('hex');

const postRaw = (raw, headers = {}) => new Promise((resolve, reject) => {
    const url = new URL('/api/payment-events/vodafone-cash', baseUrl);
    const req = http.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw), ...headers },
    }, (res) => {
        let response = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { response += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(response) }));
    });
    req.on('error', reject);
    req.end(raw);
});

const postEvent = async (payload, { bridgeId = bridgeConfig.deviceId, signature = null } = {}) => {
    const raw = JSON.stringify(payload);
    return postRaw(raw, {
        'X-Bridge-Id': bridgeId,
        'X-Signature': signature || sign(raw),
    });
};

const createPendingVodafoneDeposit = async ({
    transactionId = '022494991382', amount = 500, senderPhone = '01012572681', userOverrides = {},
} = {}) => {
    const { customer } = await createCustomerWithGroup({ currency: 'EGP', walletBalance: 100, ...userOverrides });
    const deposit = await depositService.createDepositRequest({
        userId: customer._id,
        paymentMethodId: 'vodafone',
        transactionId,
        requestedAmount: amount,
        currency: 'EGP',
        exchangeRate: 50,
        amountUsd: amount / 50,
        isElectronicWallet: true,
        senderDetails: { value: senderPhone },
    });
    return { customer, deposit };
};

const setVodafoneFee = async (feePercent) => {
    await Setting.updateOne(
        { key: 'paymentGroups' },
        { $set: { key: 'paymentGroups', value: [{
            id: 'wallets', name: 'Wallets', isActive: true,
            methods: [{ id: 'vodafone', name: 'Vodafone Cash', type: 'mobile_wallet', isActive: true, feePercent }],
        }] } },
        { upsert: true }
    );
    invalidateSettingsCache('paymentGroups');
};

beforeAll(async () => {
    bridgeConfig.enabled = true;
    bridgeConfig.hmacSecret = 'ka-bridge-test-secret';
    bridgeConfig.autoApprove = false;
    bridgeConfig.instaPayAutoApprove = false;
    bridgeConfig.deviceId = 'ka-vf-01';
    bridgeConfig.maxEventAgeMinutes = 1440;
    await connectTestDB();
    app = require('../app');
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectTestDB();
});

beforeEach(async () => {
    await clearCollections();
    bridgeConfig.enabled = true;
    bridgeConfig.hmacSecret = 'ka-bridge-test-secret';
    bridgeConfig.autoApprove = false;
    bridgeConfig.instaPayAutoApprove = false;
});

describe('Vodafone SMS bridge authentication', () => {
    test('rejects missing or invalid HMAC, wrong bridge ID, and disabled integration', async () => {
        const raw = JSON.stringify(walletSms());
        let response = await postRaw(raw, { 'X-Bridge-Id': 'ka-vf-01' });
        expect(response.status).toBe(401);

        response = await postRaw(raw, { 'X-Bridge-Id': 'ka-vf-01', 'X-Signature': '0'.repeat(64) });
        expect(response.status).toBe(401);

        response = await postEvent(walletSms(), { bridgeId: 'kanz-vf-01' });
        expect(response.status).toBe(401);

        bridgeConfig.enabled = false;
        response = await postEvent(walletSms());
        expect(response.status).toBe(503);
    });

    test('accepts a raw-body HMAC and rejects a signature for a reserialized body', async () => {
        // Deliberate whitespace makes this differ from JSON.stringify(req.body).
        // Acceptance therefore proves verification uses the raw bytes.
        const raw = '{  "text" : "تم استلام مبلغ 500 جنيه من رقم 01012572681. رقم العملية: 022494991382", "from" : "VF-Cash", "sentStamp" : 0, "receivedStamp" : 0 }';
        let response = await postRaw(raw, { 'X-Bridge-Id': 'ka-vf-01', 'X-Signature': sign(raw) });
        expect(response.status).toBe(201);
        expect(response.body.parsed).toBe(true);

        const reordered = JSON.stringify({ from: 'VF-Cash', text: 'تم استلام مبلغ 500 جنيه من رقم 01012572681. رقم العملية: 022494991383', sentStamp: 0, receivedStamp: 0 });
        response = await postRaw(reordered, { 'X-Bridge-Id': 'ka-vf-01', 'X-Signature': sign(raw) });
        expect(response.status).toBe(401);
    });
});

describe('payment SMS parser', () => {
    test('parses Vodafone data without losing a leading-zero transaction ID', () => {
        const parsed = parsePaymentSms(walletSms().text);
        expect(parsed).toMatchObject({ sourceType: 'VODAFONE_WALLET', amount: '500.00', senderPhone: '01012572681', transactionId: '022494991382' });
    });

    test('parses InstaPay and ignores failed, balance, bill, recharge, and advert messages', () => {
        expect(parsePaymentSms('Received EGP200 from 00201140058636 to Mobile Account Number 7991. Ref: 019184724786')).toMatchObject({
            sourceType: 'INSTAPAY', amount: '200.00', senderPhone: '01140058636', transactionId: '019184724786',
        });
        for (const text of ['فشلت العملية', 'رصيدك الحالي 500 جنيه', 'ادفع فاتورة الكهرباء', 'Recharge successful', 'Special offer from Vodafone']) {
            expect(parsePaymentSms(text).sourceType).toBe('NON_PAYMENT_MESSAGE');
        }
    });
});

describe('payment event persistence and matching', () => {
    test('deduplicates repeat delivery and stores exactly one event', async () => {
        const payload = walletSms();
        expect((await postEvent(payload)).status).toBe(201);
        const duplicate = await postEvent(payload);
        expect(duplicate).toMatchObject({ status: 200, body: { success: true, duplicate: true } });
        expect(await PaymentEvent.countDocuments()).toBe(1);
    });

    test('matches exact transaction, amount, and sender but has no financial effect in observe mode', async () => {
        const { customer, deposit } = await createPendingVodafoneDeposit();
        const response = await postEvent(walletSms());
        expect(response.body).toMatchObject({ parsed: true, matched: true, autoApproved: false });
        const event = await PaymentEvent.findOne();
        expect(event.matchStatus).toBe('MATCHED');
        expect(event.matchedDepositId.toString()).toBe(deposit._id.toString());
        expect((await DepositRequest.findById(deposit._id)).status).toBe(DEPOSIT_STATUS.PENDING);
        expect((await User.findById(customer._id)).walletBalance).toBe(100);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(0);
    });

    test('keeps wrong transaction unlinked and transaction/amount or phone mismatches visible', async () => {
        await createPendingVodafoneDeposit({ transactionId: '022494991999' });
        await postEvent(walletSms());
        expect((await PaymentEvent.findOne()).matchStatus).toBe('UNMATCHED');

        await clearCollections();
        await createPendingVodafoneDeposit({ amount: 499 });
        await postEvent(walletSms());
        expect((await PaymentEvent.findOne()).matchStatus).toBe('MISMATCH');

        await clearCollections();
        await createPendingVodafoneDeposit({ senderPhone: '01000000000' });
        await postEvent(walletSms());
        expect((await PaymentEvent.findOne()).matchStatus).toBe('MISMATCH');
    });

    test('links SMS-first events when the later deposit has an exact reference', async () => {
        await postEvent(walletSms());
        const { deposit } = await createPendingVodafoneDeposit();
        // The creation hook is intentionally asynchronous; invoking the matcher
        // here makes the state transition deterministic for this unit test.
        await paymentEventService.matchUnmatchedEventsForDeposit(deposit._id);
        const event = await PaymentEvent.findOne();
        expect(event.matchStatus).toBe('MATCHED');
        expect(event.matchedDepositId.toString()).toBe(deposit._id.toString());
    });

    test('marks multiple exact candidate deposits as AMBIGUOUS', async () => {
        const { deposit } = await createPendingVodafoneDeposit();
        // The public request service correctly prevents reusing a real
        // provider reference. Seed the second legacy-like pending document
        // directly to exercise the defensive ambiguity branch.
        await DepositRequest.create({
            userId: deposit.userId,
            paymentMethodId: deposit.paymentMethodId,
            transactionId: deposit.transactionId,
            requestedAmount: deposit.requestedAmount,
            currency: deposit.currency,
            exchangeRate: deposit.exchangeRate,
            amountUsd: deposit.amountUsd,
            senderDetails: deposit.senderDetails,
            paymentMethodFeePercentSnapshot: deposit.paymentMethodFeePercentSnapshot,
        });
        await postEvent(walletSms());
        expect((await PaymentEvent.findOne()).matchStatus).toBe('AMBIGUOUS');
    });
});

describe('future auto-approval path', () => {
    test('uses the canonical deposit approval transaction exactly once when explicitly enabled in isolation', async () => {
        bridgeConfig.autoApprove = true;
        await setVodafoneFee(1);
        const { customer, deposit } = await createPendingVodafoneDeposit();
        const response = await postEvent(walletSms());
        expect(response.body.autoApproved).toBe(true);
        expect(await DepositRequest.findById(deposit._id)).toMatchObject({
            status: 'APPROVED', reviewSource: 'VODAFONE_SMS_AUTO', paymentMethodFeePercentSnapshot: 1, paymentMethodFeeAmount: 5, netAmount: 495, walletCreditAmount: 495,
        });
        expect((await User.findById(customer._id)).walletBalance).toBe(595);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(1);
        expect((await postEvent(walletSms())).body.duplicate).toBe(true);
        expect(await WalletTransaction.countDocuments({ userId: customer._id })).toBe(1);
    });
});
