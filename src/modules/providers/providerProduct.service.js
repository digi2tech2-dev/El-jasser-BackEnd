'use strict';

/**
 * providerProduct.service.js
 *
 * Layer 2 service — ProviderProduct CRUD and admin queries.
 *
 * These records are INTERNAL ONLY. They are never exposed to end-users.
 * Admins browse them to decide which products to publish to the platform.
 *
 * Responsibilities:
 *   - List / search provider products (admin product-selection screen)
 *   - Update translatedName or other admin annotations
 *   - Get by ID (used by publish flow)
 */

const { ProviderProduct } = require('./providerProduct.model');
const { Provider } = require('./provider.model');
const { NotFoundError } = require('../../shared/errors/AppError');
const { normalizeProviderDecimalPrice } = require('../../shared/utils/decimalPrecision');
const {
    KARAK_DYNAMIC_PRODUCT_ID,
    KARAK_DYNAMIC_PRODUCT,
    isKarakProvider,
    getDealerDynamicApp,
    getDealerDynamicProductById,
    buildDealerDynamicProductDto,
} = require('./adapters/dealerApi.service');

const toPlainObject = (value) => {
    if (!value) return value;
    if (typeof value.toObject === 'function') {
        return value.toObject({ getters: false, virtuals: false });
    }
    return { ...value };
};

const toRawPayloadObject = (rawPayload) => (
    rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
        ? rawPayload
        : {}
);

const PRICE_FIELD_KEYS = Object.freeze([
    'price',
    'rawPrice',
    'costPrice',
    'providerPrice',
    'product_price',
    'base_price',
    'basePrice',
]);

const normalizeRawPayloadPrices = (rawPayload) => {
    const payload = toRawPayloadObject(rawPayload);

    if (!Object.keys(payload).length) return rawPayload ?? null;

    const normalized = { ...payload };
    for (const key of PRICE_FIELD_KEYS) {
        if (Object.prototype.hasOwnProperty.call(normalized, key)) {
            normalized[key] = normalizeProviderDecimalPrice(normalized[key]);
        }
    }

    return normalized;
};

const normalizeProviderProductPrices = (product) => {
    const plain = toPlainObject(product);
    if (!plain) return plain;

    const normalized = { ...plain };

    for (const key of PRICE_FIELD_KEYS) {
        if (Object.prototype.hasOwnProperty.call(normalized, key)) {
            normalized[key] = normalizeProviderDecimalPrice(normalized[key]);
        }
    }

    normalized.rawPayload = normalizeRawPayloadPrices(normalized.rawPayload);

    return normalized;
};

const buildNormalizedDynamicProduct = (product, dynamicProduct) => {
    const plain = normalizeProviderProductPrices(product);
    const price = normalizeProviderDecimalPrice(dynamicProduct.price);

    return {
        ...plain,
        id: plain.id ?? plain._id,
        externalProductId: dynamicProduct.id,
        rawName: dynamicProduct.name,
        rawPrice: price,
        price,
        costPrice: price,
        providerPrice: price,
        minQty: dynamicProduct.minQty,
        maxQty: dynamicProduct.maxQty,
        isActive: true,
        rawPayload: {
            ...toRawPayloadObject(plain.rawPayload),
            ...dynamicProduct,
            product_id: dynamicProduct.id,
            product_name: dynamicProduct.name,
            product_price: price,
        },
    };
};

const isDealerDynamicProduct = (product) => Boolean(
    getDealerDynamicProductById(product?.externalProductId)
);

const isKarakDynamicProduct = (product) => (
    String(product?.externalProductId || '').trim() === KARAK_DYNAMIC_PRODUCT_ID
);

const normalizeDealerDynamicProduct = (product) => {
    const plain = normalizeProviderProductPrices(product);
    const dynamicProduct = getDealerDynamicProductById(plain?.externalProductId);

    if (!dynamicProduct) return plain;

    return buildNormalizedDynamicProduct(plain, dynamicProduct);
};

const normalizeKarakDynamicProduct = (product) => {
    const plain = normalizeProviderProductPrices(product);

    if (!isKarakDynamicProduct(plain)) return plain;

    return buildNormalizedDynamicProduct(plain, KARAK_DYNAMIC_PRODUCT);
};

const ensureDynamicProduct = async (providerId, resolveDynamicApp) => {
    if (!providerId) return null;

    const provider = await Provider.findById(providerId)
        .select('name slug code providerCode isActive')
        .lean();

    if (!provider) return null;

    const dynamicApp = resolveDynamicApp(provider);
    if (!dynamicApp) return null;

    const dto = buildDealerDynamicProductDto(dynamicApp);
    const now = new Date();

    return ProviderProduct.findOneAndUpdate(
        {
            provider: provider._id,
            externalProductId: dto.externalProductId,
        },
        {
            $set: {
                rawName: dto.rawName,
                rawPrice: dto.rawPrice,
                minQty: dto.minQty,
                maxQty: dto.maxQty,
                isActive: true,
                rawPayload: dto.rawPayload,
                lastSyncedAt: now,
            },
        },
        {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
        }
    );
};

const ensureDealerDynamicProduct = (providerId) => ensureDynamicProduct(
    providerId,
    getDealerDynamicApp
);

const ensureKarakDynamicProduct = (providerId) => ensureDynamicProduct(
    providerId,
    (provider) => (isKarakProvider(provider) ? getDealerDynamicApp(provider) : null)
);

// =============================================================================
// LIST / SEARCH
// =============================================================================

/**
 * listProviderProducts(filter, paginationOptions)
 *
 * Returns a paginated list of ProviderProducts.
 *
 * @param {Object} filter               - Mongoose filter (e.g. { provider, isActive })
 * @param {Object} [opts]
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=50]
 * @param {string} [opts.search]        - partial text match on rawName / translatedName
 * @returns {Promise<{ products, pagination }>}
 */
const listProviderProducts = async (filter = {}, { page = 1, limit = 500, search } = {}) => {
    const query = { ...filter };

    if (query.provider) {
        await ensureDealerDynamicProduct(query.provider);
    }

    if (search) {
        const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        query.$or = [{ rawName: re }, { translatedName: re }];
    }

    const skip = (page - 1) * limit;

    const [products, total] = await Promise.all([
        ProviderProduct.find(query)
            .sort({ rawName: 1 })
            .skip(skip)
            .limit(limit)
            .populate('provider', 'name slug'),
        ProviderProduct.countDocuments(query),
    ]);

    return {
        products: products.map(normalizeDealerDynamicProduct),
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
        },
    };
};

// =============================================================================
// GET ONE
// =============================================================================

/**
 * getProviderProductById(id)
 * Throws NotFoundError if missing.
 */
const getProviderProductById = async (id) => {
    const pp = await ProviderProduct.findById(id).populate('provider', 'name slug isActive');
    if (!pp) throw new NotFoundError('ProviderProduct');
    return normalizeDealerDynamicProduct(pp);
};

// =============================================================================
// ADMIN ANNOTATIONS
// =============================================================================

/**
 * setTranslatedName(providerProductId, translatedName)
 *
 * Admin sets a human-friendly localised name for a raw provider product.
 * This value is NEVER overwritten by sync runs.
 *
 * @returns {Promise<ProviderProduct>}
 */
const setTranslatedName = async (providerProductId, translatedName) => {
    const pp = await ProviderProduct.findByIdAndUpdate(
        providerProductId,
        { $set: { translatedName: translatedName?.trim() || null } },
        { new: true, runValidators: true }
    );
    if (!pp) throw new NotFoundError('ProviderProduct');
    return pp;
};

module.exports = {
    listProviderProducts,
    getProviderProductById,
    setTranslatedName,
    ensureDealerDynamicProduct,
    ensureKarakDynamicProduct,
    normalizeDealerDynamicProduct,
    normalizeKarakDynamicProduct,
    isDealerDynamicProduct,
    isKarakDynamicProduct,
};
