'use strict';

const { getPaymentSettings } = require('../admin/admin.settings.service');
const { normalizePaymentMethodFeePercent } = require('./paymentMethodFee');

const normalizePaymentMethodType = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

const isElectronicWalletType = (value) => [
    'mobile_wallet',
    'e_wallet',
    'ewallet',
    'electronic_wallet',
].includes(normalizePaymentMethodType(value));

// Mirrors the customer-facing fallback methods used when paymentGroups has not
// yet been configured. A persisted method's configured type always wins.
const DEFAULT_ELECTRONIC_WALLET_METHOD_IDS = new Set([
    'vodafone',
    'vodafonecash',
    'instapay',
    'orangecash',
    'etisalatcash',
]);

const normalizePaymentMethodId = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');

const getDepositPaymentMethodRequirements = async (paymentMethodId) => {
    const normalizedId = String(paymentMethodId || '').trim();
    const settings = await getPaymentSettings();
    const method = (settings.paymentGroups || [])
        .flatMap((group) => group.methods || [])
        .find((entry) => String(entry?.id || '').trim() === normalizedId);

    return {
        isElectronicWallet: method
            ? isElectronicWalletType(method.type)
            : DEFAULT_ELECTRONIC_WALLET_METHOD_IDS.has(normalizePaymentMethodId(normalizedId)),
        // Missing feePercent is legacy configuration and intentionally means 0.
        // Invalid present values fail closed before a deposit can be created.
        paymentMethodFeePercent: method
            ? normalizePaymentMethodFeePercent(method.feePercent, { allowMissing: true })
            : 0,
    };
};

module.exports = {
    isElectronicWalletType,
    getDepositPaymentMethodRequirements,
};
