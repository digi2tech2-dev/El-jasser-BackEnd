'use strict';

const { getPaymentSettings } = require('../admin/admin.settings.service');

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
    };
};

module.exports = {
    isElectronicWalletType,
    getDepositPaymentMethodRequirements,
};
