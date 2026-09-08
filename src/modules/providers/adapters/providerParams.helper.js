'use strict';

const TARGET_ALIASES = Object.freeze([
    'playerId',
    'player_id',
    'uid',
    'userId',
    'user_id',
    'accountId',
    'account_id',
    'toUserId',
    'target',
    'link',
]);

const TARGET_DISPLAY_ALIASES = Object.freeze([
    'ايدي المستخدم',
    'ايدى المستخدم',
    'آيدي المستخدم',
    'معرف المستخدم',
    'رقم المستخدم',
    'حساب المستخدم',
    'رابط الحساب',
    'ايدي الحساب',
    'معرف الحساب',
    'رقم الحساب',
    'ايدي اللاعب',
    'ايدى اللاعب',
    'آيدي اللاعب',
    'معرف اللاعب',
    'رقم اللاعب',
    'لاعب',
    'اللاعب',
    'المستخدم',
    'يوزر',
    'يوزر ايدي',
    'ايدي',
    'ID',
    'Player ID',
    'User ID',
    'Account ID',
]);

const RESERVED_ID_KEYS = Object.freeze([
    '_id',
    'productId',
    'externalProductId',
    'providerProductId',
    'providerId',
    'providerOrderId',
    'orderId',
    'order_id',
    'orderUuid',
    'order_uuid',
    'referenceId',
    'compatProductId',
]);

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const normalizeTargetAliasKey = (value) => String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ـ/g, '')
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, '');

const TARGET_ALIAS_LOOKUP = new Set([
    ...TARGET_ALIASES,
    ...TARGET_DISPLAY_ALIASES,
].map(normalizeTargetAliasKey).filter(Boolean));

const toPlainObject = (params = {}) => {
    if (params instanceof Map) return Object.fromEntries(params.entries());
    if (!params || typeof params !== 'object' || Array.isArray(params)) return {};
    return { ...params };
};

const cleanTargetValue = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed ? trimmed : null;
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
        const trimmed = String(value).trim();
        return trimmed ? trimmed : null;
    }
    return null;
};

const hasReservedIdContext = (params) => RESERVED_ID_KEYS.some((key) => hasOwn(params, key));

const isTargetAliasKey = (key) => TARGET_ALIAS_LOOKUP.has(normalizeTargetAliasKey(key));

const extractTargetId = (params = {}) => {
    const source = toPlainObject(params);

    for (const key of TARGET_ALIASES) {
        if (!hasOwn(source, key)) continue;
        const value = cleanTargetValue(source[key]);
        if (value) return value;
    }

    for (const [key, rawValue] of Object.entries(source)) {
        const normalizedKey = normalizeTargetAliasKey(key);
        if (!TARGET_ALIAS_LOOKUP.has(normalizedKey)) continue;
        if (normalizedKey === 'id' && key === 'id' && hasReservedIdContext(source)) continue;

        const value = cleanTargetValue(rawValue);
        if (value) return value;
    }

    if (hasOwn(source, 'id') && !hasReservedIdContext(source)) {
        return cleanTargetValue(source.id);
    }

    return null;
};

const hasTargetId = (params = {}) => Boolean(extractTargetId(params));

const normalizeParamAliases = (params = {}) => {
    const normalized = toPlainObject(params);
    const targetId = extractTargetId(normalized);
    if (!targetId) return normalized;

    normalized.playerId = targetId;
    return normalized;
};

module.exports = {
    TARGET_ALIASES,
    TARGET_DISPLAY_ALIASES,
    extractTargetId,
    hasTargetId,
    isTargetAliasKey,
    normalizeTargetAliasKey,
    normalizeParamAliases,
};
