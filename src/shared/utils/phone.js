'use strict';

const { AppError } = require('../errors/AppError');

const toWesternDigits = (value) => String(value || '')
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));

/**
 * Normalize a customer phone number without guessing a country calling code.
 * Stored values contain ASCII digits and, when supplied, one leading `+`.
 */
const normalizePhone = (value, { required = false } = {}) => {
    if (value === undefined || value === null || String(value).trim() === '') {
        if (required) {
            throw new AppError('Phone number is required.', 400, 'PHONE_REQUIRED');
        }
        return null;
    }

    const raw = toWesternDigits(value).trim();
    if (!/^[0-9+ ()-]+$/.test(raw)) {
        throw new AppError('Phone number contains invalid characters.', 400, 'PHONE_INVALID');
    }

    const hasLeadingPlus = raw.startsWith('+');
    if ((raw.match(/\+/g) || []).length > (hasLeadingPlus ? 1 : 0)) {
        throw new AppError('Phone number has an invalid plus sign.', 400, 'PHONE_INVALID');
    }

    const digits = raw.replace(/[ ()-]/g, '').replace(/^\+/, '');
    if (!/^\d{7,15}$/.test(digits)) {
        throw new AppError('Phone number must contain between 7 and 15 digits.', 400, 'PHONE_INVALID');
    }

    return `${hasLeadingPlus ? '+' : ''}${digits}`;
};

const isValidPhone = (value) => {
    try {
        return Boolean(normalizePhone(value));
    } catch (_) {
        return false;
    }
};

module.exports = {
    normalizePhone,
    isValidPhone,
    toWesternDigits,
};
