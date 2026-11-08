'use strict';

const Decimal = require('decimal.js');
const { Provider } = require('../providers/provider.model');
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

module.exports = { search };
