'use strict';

const { Decimal } = require('../../shared/utils/decimalPrecision');

const PAYMENT_EVENT_SOURCE_TYPES = Object.freeze({
    VODAFONE_WALLET: 'VODAFONE_WALLET',
    INSTAPAY: 'INSTAPAY',
    NON_PAYMENT_MESSAGE: 'NON_PAYMENT_MESSAGE',
    UNSUPPORTED_PAYMENT_FORMAT: 'UNSUPPORTED_PAYMENT_FORMAT',
});

const toWesternDigits = (value) => String(value || '')
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/٫/g, '.')
    .replace(/٬/g, '');

const normalizePhone = (value) => {
    let digits = toWesternDigits(value).replace(/\D/g, '');
    if (digits.startsWith('0020')) digits = digits.slice(4);
    else if (digits.startsWith('20')) digits = digits.slice(2);

    if (digits.length === 10 && digits.startsWith('1')) digits = `0${digits}`;
    return /^01\d{9}$/.test(digits) ? digits : null;
};

const normalizeAmount = (value) => {
    try {
        const amount = new Decimal(toWesternDigits(value).trim());
        if (!amount.isFinite() || amount.lte(0) || amount.decimalPlaces() > 2) return null;
        return amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
    } catch (_) {
        return null;
    }
};

const normalizeTransactionId = (value) => {
    const id = toWesternDigits(value).replace(/\s/g, '');
    return /^\d{8,20}$/.test(id) ? id : null;
};

const isKnownNonPaymentMessage = (text) => /(?:فشل|لم\s*يتم|رصيدك|الرصيد|اعلان|عرض|شحن|فاتورة|دفع\s*فاتورة|recharge|bill\s*payment|available\s*balance|failed|declined|promotion|offer)/iu.test(text);

const parseVodafoneWallet = (text) => {
    const amountMatch = text.match(/تم\s*استلام\s*مبلغ\s*([0-9٠-٩۰-۹]+(?:[\.٫][0-9٠-٩۰-۹]{1,2})?)\s*جنيه/iu);
    const phoneMatch = text.match(/من\s*رقم\s*([+0-9٠-٩۰-۹\s-]{10,20})/iu);
    const transactionMatch = text.match(/رقم\s*العملية\s*[:：\-]?\s*([0-9٠-٩۰-۹\s]{8,30})/iu);
    if (!amountMatch && !phoneMatch && !transactionMatch) return null;

    const amount = amountMatch && normalizeAmount(amountMatch[1]);
    const senderPhone = phoneMatch && normalizePhone(phoneMatch[1]);
    const transactionId = transactionMatch && normalizeTransactionId(transactionMatch[1]);
    if (!amount || !senderPhone || !transactionId) {
        return { sourceType: PAYMENT_EVENT_SOURCE_TYPES.UNSUPPORTED_PAYMENT_FORMAT, parseStatus: 'FAILED' };
    }
    return {
        sourceType: PAYMENT_EVENT_SOURCE_TYPES.VODAFONE_WALLET,
        parseStatus: 'PARSED',
        amount,
        senderPhone,
        transactionId,
    };
};

const parseInstaPay = (text) => {
    const paymentMatch = text.match(/received\s+egp\s*([0-9٠-٩۰-۹]+(?:[\.٫][0-9٠-٩۰-۹]{1,2})?)\s+from\s+([+0-9٠-٩۰-۹\s-]{11,24})/iu);
    const refMatch = text.match(/\bref\s*[:：#-]?\s*([0-9٠-٩۰-۹\s]{8,30})/iu);
    if (!paymentMatch && !refMatch) return null;

    const amount = paymentMatch && normalizeAmount(paymentMatch[1]);
    const senderPhone = paymentMatch && normalizePhone(paymentMatch[2]);
    const transactionId = refMatch && normalizeTransactionId(refMatch[1]);
    if (!amount || !senderPhone || !transactionId) {
        return { sourceType: PAYMENT_EVENT_SOURCE_TYPES.UNSUPPORTED_PAYMENT_FORMAT, parseStatus: 'FAILED' };
    }
    return {
        sourceType: PAYMENT_EVENT_SOURCE_TYPES.INSTAPAY,
        parseStatus: 'PARSED',
        amount,
        senderPhone,
        transactionId,
    };
};

const parsePaymentSms = (rawMessage) => {
    const text = String(rawMessage || '');
    if (!text.trim()) {
        return { sourceType: PAYMENT_EVENT_SOURCE_TYPES.NON_PAYMENT_MESSAGE, parseStatus: 'IGNORED' };
    }

    // Payment SMS messages can contain balance text such as "رصيدك الحالي".
    // Always attempt to parse supported payment formats before applying
    // the generic non-payment-message filter.
    const parsedPayment = parseVodafoneWallet(text) || parseInstaPay(text);
    if (parsedPayment) {
        return parsedPayment;
    }

    if (isKnownNonPaymentMessage(text)) {
        return { sourceType: PAYMENT_EVENT_SOURCE_TYPES.NON_PAYMENT_MESSAGE, parseStatus: 'IGNORED' };
    }

    return { sourceType: PAYMENT_EVENT_SOURCE_TYPES.NON_PAYMENT_MESSAGE, parseStatus: 'IGNORED' };
};

module.exports = {
    PAYMENT_EVENT_SOURCE_TYPES,
    parsePaymentSms,
    normalizePhone,
    normalizeAmount,
    normalizeTransactionId,
    toWesternDigits,
};
