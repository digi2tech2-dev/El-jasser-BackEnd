'use strict';

/**
 * admin.settings.service.js
 *
 * CRUD over the Setting collection.
 * Only admins can write. Reads can be used internally.
 */

const { Setting } = require('./setting.model');
const { NotFoundError, ConflictError, ValidationError } = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { ADMIN_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');
const settingsCache = require('./settings.cache');
const {
    validatePaymentGroupsFeePercent,
    validatePaymentGroupsQrCodeImages,
} = require('../deposits/paymentMethodFee');

const PAYMENT_SETTING_KEYS = new Set([
    'paymentGroups',
    'paymentCountryAccounts',
    'paymentInstructions',
    'whatsappNumber',
    'supportContacts',
]);

// ─── List ──────────────────────────────────────────────────────────────────────

const listSettings = async () => {
    return Setting.find().sort({ key: 1 }).select('-__v');
};

// ─── Get One ──────────────────────────────────────────────────────────────────

const getSettingByKey = async (key) => {
    const setting = await Setting.findOne({ key });
    if (!setting) throw new NotFoundError('Setting');
    return setting;
};

// ─── Get value (internal use) ─────────────────────────────────────────────────

const getSettingValue = async (key, defaultValue = null) => {
    const setting = await Setting.findOne({ key }).lean();
    return setting ? setting.value : defaultValue;
};

const getPaymentSettings = async () => {
    const cacheKey = settingsCache.SETTINGS_CACHE_KEYS.paymentGroups;
    const cached = settingsCache.get(cacheKey);
    if (cached) return cached;

    const keys = [...PAYMENT_SETTING_KEYS];
    const settings = await Setting.find({ key: { $in: keys } }).lean();
    const find = (key) => settings.find((s) => s.key === key)?.value;

    const paymentGroups = (find('paymentGroups') || [])
        .filter((g) => g.isActive !== false)
        .map((g) => ({
            ...g,
            methods: (g.methods || []).filter((m) => m.isActive !== false),
        }))
        .filter((g) => g.methods && g.methods.length > 0);

    const payload = {
        paymentGroups,
        countryAccounts: find('paymentCountryAccounts') || [],
        instructions: find('paymentInstructions') || '',
        whatsappNumber: find('whatsappNumber') || '',
        supportContacts: find('supportContacts') || { entries: [], revision: 0 },
    };

    return settingsCache.set(cacheKey, payload);
};

const invalidateSettingsCache = (key) => {
    if (!key) {
        settingsCache.clear();
        return;
    }

    if (PAYMENT_SETTING_KEYS.has(key)) {
        settingsCache.del(settingsCache.SETTINGS_CACHE_KEYS.paymentGroups);
    }
};

// ─── Update ───────────────────────────────────────────────────────────────────

const updateSetting = async (key, value, adminId) => {
    let setting = await Setting.findOne({ key });
    if (!setting) throw new NotFoundError('Setting');

    const before = setting.value;

    if (key === 'supportContacts') {
        const currentRevision = Number(setting.value?.revision || 0);
        if (!value || !Array.isArray(value.entries) || Number(value.revision) !== currentRevision) {
            throw new ConflictError('Support contacts changed. Reload before saving.');
        }
        if (value.entries.length > 30 || value.entries.some((item) => !item || !String(item.name || '').trim()
            || !String(item.role || '').trim() || !/^\+[1-9]\d{7,14}$/.test(String(item.number || '').trim()))) {
            throw new ValidationError('Invalid support contacts.');
        }
        value = { entries: value.entries.map((item) => ({
            id: String(item.id || ''), name: String(item.name).trim(), role: String(item.role).trim(), number: String(item.number).trim(),
        })), revision: currentRevision + 1 };
    }

    if (key === 'adminNotificationWhatsApp' && value !== ''
        && !/^\+[1-9]\d{7,14}$/.test(String(value).trim())) {
        throw new ValidationError('Enter an international WhatsApp number.');
    }

    if (key === 'paymentGroups') {
        validatePaymentGroupsFeePercent(value);
        validatePaymentGroupsQrCodeImages(value);
    }

    // Mongoose does not detect mutations to Mixed-type fields.
    // Without markModified(), `.save()` silently skips the write.
    setting.value = value;
    setting.updatedBy = adminId;
    setting.markModified('value');
    await setting.save();

    invalidateSettingsCache(key);

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.SETTING_UPDATED,
        entityType: ENTITY_TYPES.SETTING,
        entityId: setting._id,
        metadata: { key, before, after: value },
    });

    return setting;
};

module.exports = {
    listSettings,
    getSettingByKey,
    getSettingValue,
    getPaymentSettings,
    invalidateSettingsCache,
    updateSetting,
};
