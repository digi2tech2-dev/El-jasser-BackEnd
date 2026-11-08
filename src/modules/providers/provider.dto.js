'use strict';

// Explicit response fields: credentials (including effectiveToken) must remain
// available internally to adapters, but must never cross the CRUD API boundary.
const RESPONSE_FIELDS = [
    '_id', 'id', 'name', 'slug', 'adapterType', 'baseUrl', 'isActive',
    'syncInterval', 'supportedFeatures', 'deletedAt', 'createdAt', 'updatedAt', '__v',
];

const toSafeProviderDTO = (provider) => {
    const source = provider?.toObject
        ? provider.toObject({ virtuals: false, getters: false, transform: false })
        : (provider || {});
    const dto = Object.fromEntries(
        RESPONSE_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(source, key))
            .map((key) => [key, source[key]])
    );

    // Preserve the existing admin meaning: a legacy apiKey is also a usable token.
    dto.hasApiToken = Boolean(source.apiToken || source.apiKey || source.hasApiToken);
    dto.hasApiKey = Boolean(source.apiKey || source.hasApiKey);
    return dto;
};

module.exports = { toSafeProviderDTO };
