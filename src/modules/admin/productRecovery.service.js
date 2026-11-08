'use strict';

const Decimal = require('decimal.js');
const { Provider } = require('../providers/provider.model');
const { ProviderProduct } = require('../providers/providerProduct.model');
const mongoose = require('mongoose');
const { syncProviderProducts } = require('../providers/providerProductSync.service');
const productService = require('../products/product.service');
const { NotFoundError } = require('../../shared/errors/AppError');
const { getProviderAdapter } = require('../providers/adapters/adapter.factory');
const { MockProviderAdapter } = require('../providers/adapters/mock.adapter');
const { ValidationError } = require('../../shared/errors/AppError');
const providerCache = new Map();
const CACHE_MS = 30 * 1000;

function fetchCachedProducts(provider, adapter, refresh = false) {
    const key = String(provider._id);
    const now = Date.now();
    const version = provider.updatedAt?.getTime() || 0;
    const cached = providerCache.get(key);
    if (!refresh && cached && cached.version === version && now - cached.loadedAt < CACHE_MS) return cached.promise;
    const promise = Promise.resolve().then(() => adapter.fetchProducts());
    providerCache.set(key, { version, loadedAt: now, promise });
    promise.catch(() => { if (providerCache.get(key)?.promise === promise) providerCache.delete(key); });
    // Keep only a bounded number of recent suppliers across configuration changes.
    if (providerCache.size > 100) providerCache.delete(providerCache.keys().next().value);
    return promise;
}

// Read-only discovery: unlike a catalogue sync, searching must never change
// existing provider products or their linked storefront prices.
async function search({ search = '', providerId = '', page = 1, limit = 30, sort = 'asc', availability = 'all', minPrice = '', maxPrice = '', refresh = false } = {}) {
    const query = String(search).trim();
    if (query.length > 120 || !['asc', 'desc'].includes(sort) || !['all', 'available', 'unavailable'].includes(availability)
        || !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new ValidationError('Invalid recovery search parameters.');
    }
    let minimum = null;
    let maximum = null;
    try {
        if (minPrice !== '') minimum = new Decimal(minPrice);
        if (maxPrice !== '') maximum = new Decimal(maxPrice);
        if (minimum && (!minimum.isFinite() || minimum.isNegative()) || maximum && (!maximum.isFinite() || maximum.isNegative())
            || minimum && maximum && minimum.gt(maximum)) throw new Error('Invalid price range');
    } catch { throw new ValidationError('Invalid price range.'); }
    const filter = { isActive: true, deletedAt: null };
    if (providerId) {
        if (!require('mongoose').isValidObjectId(providerId)) throw new ValidationError('Invalid provider ID.');
        filter._id = providerId;
    }
    const providers = await Provider.find(filter).select('+apiToken +apiKey');
    const results = [];
    const failures = [];
    // Bound simultaneous upstream calls without modifying existing sync state.
    let cursor = 0;
    async function worker() {
        while (cursor < providers.length) {
            const provider = providers[cursor++];
            try {
                const adapter = getProviderAdapter(provider, { strict: true });
                if (adapter instanceof MockProviderAdapter) throw new Error('Mock provider is not allowed.');
                const products = await fetchCachedProducts(provider, adapter, refresh);
                if (!Array.isArray(products)) throw new Error('Invalid provider response.');
                const seen = new Set();
                for (const item of products) {
                    const raw = item.rawPayload && typeof item.rawPayload === 'object' ? item.rawPayload : {};
                    const name = String(item.rawName || '').trim();
                    const externalId = String(item.externalProductId || '').trim();
                    if (!externalId || !name || seen.has(externalId) || (query && !name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) continue;
                    seen.add(externalId);
                    const rawAvailability = raw.available ?? raw.isActive ?? raw.active ?? raw.status;
                    const status = String(rawAvailability ?? '').trim().toLowerCase();
                    const available = item.isActive === false || ['false', '0', 'inactive', 'disabled', 'off', 'unavailable'].includes(status)
                        ? false : ['true', '1', 'active', 'enabled', 'on', 'available'].includes(status) ? true : null;
                    if (availability === 'available' && available !== true || availability === 'unavailable' && available !== false) continue;
                    const sourceCurrency = String(raw.sourceCurrency || raw.currency || raw.pricingCurrency || '').trim().toUpperCase();
                    // Preserve the supplier amount even when currency metadata is absent.
                    const supplierPrice = raw.sourcePrice ?? item.rawPrice;
                    const price = supplierPrice == null ? '' : String(supplierPrice).trim();
                    let numericPrice = null;
                    try {
                        if (price) {
                            const parsed = new Decimal(price);
                            if (parsed.isFinite() && parsed.gte(0)) numericPrice = parsed;
                        }
                    } catch { /* Keep the supplier value visible even when it cannot be sorted. */ }
                    if ((minimum || maximum) && (!numericPrice || minimum && numericPrice.lt(minimum) || maximum && numericPrice.gt(maximum))) continue;
                    const image = [raw.image, raw.image_url, raw.imageUrl, raw.product_image].find((v) => {
                        if (typeof v !== 'string') return false;
                        try {
                            const url = new URL(v);
                            return url.protocol === 'https:' && !url.username && !url.password && !url.search;
                        } catch { return false; }
                    }) || null;
                    const limitRange = raw.qty_values && typeof raw.qty_values === 'object'
                        ? [raw.qty_values.min, raw.qty_values.max]
                        : [raw.minQty ?? raw.min_qty ?? raw.min_quantity ?? raw.min_order ?? raw.min,
                            raw.maxQty ?? raw.max_qty ?? raw.max_quantity ?? raw.max_order ?? raw.max];
                    const limitsVerified = limitRange.every((v) => v !== null && v !== undefined && v !== '')
                        && limitRange.every((v) => Number.isSafeInteger(Number(v)) && Number(v) > 0)
                        && Number(limitRange[0]) <= Number(limitRange[1]);
                    results.push({ key: `${provider._id}:${externalId}`, providerId: String(provider._id), providerName: provider.name,
                        externalProductId: externalId, name, price: price || null,
                        currency: sourceCurrency || null, available, image,
                        minQty: limitsVerified ? Number(limitRange[0]) : null,
                        maxQty: limitsVerified ? Number(limitRange[1]) : null,
                        limitsVerified,
                        description: typeof raw.description === 'string' ? raw.description.slice(0, 400) : null,
                        lastCheckedAt: new Date().toISOString() });
                }
            } catch (error) {
                // Do not return upstream exception bodies, tokens, URLs or credentials to the browser.
                failures.push({ providerId: String(provider._id), providerName: provider.name, message: 'تعذر قراءة منتجات المورد. تحقق من الاتصال وإعدادات المورد.' });
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(providers.length, 4) }, () => worker()));
    results.sort((a, b) => {
        const sortable = (value) => {
            if (value == null || value === '') return null;
            try { const parsed = new Decimal(value); return parsed.isFinite() && parsed.gte(0) ? parsed : null; }
            catch { return null; }
        };
        const aPrice = sortable(a.price);
        const bPrice = sortable(b.price);
        if (!aPrice || !bPrice) return !aPrice ? (!bPrice ? a.name.localeCompare(b.name) : 1) : -1;
        const diff = aPrice.comparedTo(bPrice);
        return (sort === 'desc' ? -diff : diff) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
    });
    const total = results.length;
    return { items: results.slice((page - 1) * limit, page * limit), total, page, limit, failures };
}

const MAX_PUBLISH_ITEMS = 50;
async function publish(products = [], adminUserId) {
    if (!Array.isArray(products) || products.length < 1 || products.length > MAX_PUBLISH_ITEMS) {
        throw new ValidationError(`Select between 1 and ${MAX_PUBLISH_ITEMS} products.`);
    }
    const seen = new Set();
    for (const item of products) {
        if (!item || !mongoose.isValidObjectId(item.providerId)
            || typeof item.externalProductId !== 'string' || !item.externalProductId.trim() || item.externalProductId.length > 200
            || typeof item.name !== 'string' || item.name.trim().length < 2 || item.name.trim().length > 200
            || typeof item.image !== 'string' || !item.image.trim().startsWith('/uploads/products/') || item.image.length > 500) {
            throw new ValidationError('Each product requires a valid supplier, ID, name and uploaded image.');
        }
        let markup;
        try {
            markup = new Decimal(item.markupValue === undefined || item.markupValue === '' ? 0 : item.markupValue);
            if (!markup.isFinite() || markup.isNegative() || markup.gt(1000000)) throw new Error('Invalid markup');
        } catch { throw new ValidationError('Markup must be a valid non-negative amount.'); }
        const key = `${item.providerId}:${item.externalProductId.trim()}`;
        if (seen.has(key)) throw new ValidationError('Duplicate products are not allowed in one request.');
        seen.add(key);
    }

    const providerSync = new Map();
    for (const providerId of new Set(products.map((item) => String(item.providerId)))) {
        try {
            await syncProviderProducts(providerId);
            providerSync.set(providerId, null);
        } catch {
            providerSync.set(providerId, 'تعذر تحديث بيانات المورد. تحقق من اتصال المورد ثم أعد المحاولة.');
        }
    }

    const published = [];
    const failed = [];
    for (const item of products) {
        const key = `${item.providerId}:${item.externalProductId.trim()}`;
        try {
            const syncError = providerSync.get(String(item.providerId));
            if (syncError) throw new Error(syncError);
            const providerProduct = await ProviderProduct.findOne({ provider: item.providerId, externalProductId: item.externalProductId.trim() });
            if (!providerProduct) throw new NotFoundError('Provider product');
            if (!providerProduct.isActive) throw new Error('المنتج غير متاح لدى المورد.');
            const markupValue = new Decimal(item.markupValue === undefined || item.markupValue === '' ? 0 : item.markupValue).toString();
            const sourceName = providerProduct.translatedName || providerProduct.rawName || item.name.trim();
            const sourceDescription = typeof providerProduct.rawPayload?.description === 'string' ? providerProduct.rawPayload.description : null;
            const product = await productService.createProductFromProvider({
                providerProductId: providerProduct._id,
                name: sourceName, description: sourceDescription, image: item.image.trim(),
                minQty: providerProduct.minQty, maxQty: providerProduct.maxQty,
                pricingMode: 'sync', markupType: 'fixed', markupValue,
                isActive: true, executionType: 'automatic', createdBy: adminUserId,
            });
            published.push({ key, productId: String(product._id), name: product.name });
        } catch (error) {
            failed.push({ key, name: item.name.trim(), message: error?.statusCode === 409 ? 'المنتج منشور بالفعل.' : error?.message || 'تعذر تفعيل المنتج.' });
        }
    }
    return { published, failed };
}
module.exports = { search, publish };
