'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { BaseProviderAdapter } = require('./base.adapter');
const { extractTargetId } = require('./providerParams.helper');

const INTERNAL_KEYS = new Set([
    'productId', 'externalProductId', 'providerProductId', 'providerId',
    'quantity', 'amount', 'qty', 'referenceId', 'orderUuid', 'order_uuid',
    'price', 'basePrice', 'providerPrice', 'walletBalance', 'balance', 'currency',
]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_CODES = new Set([100, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 120, 121, 122, 123, 130, 500]);

// Fulfillment persists orderNumber, not a UUID. Derive a stable UUID-shaped
// idempotency key so placement retries and cron recovery work across restarts.
const referenceUuid = (reference) => {
    const value = String(reference ?? '').trim();
    if (!value) throw new Error('[AlmotasimCard] referenceId / order_uuid is required');
    if (UUID_V4.test(value)) return value.toLowerCase();
    const bytes = crypto.createHash('sha256').update(`almotasim-card:order:${value}`).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const isApiError = (data) => data && typeof data === 'object' && (
    ['error', 'reject'].includes(String(data.status ?? '').toLowerCase())
    || data.success === false
    || (!data.order && !data.orders && ERROR_CODES.has(Number(data.code)))
);
const errorMessage = (data) => data?.message || data?.msg || data?.error || `Almotasim Card API error (code ${data?.code ?? 'unknown'})`;
const assertApiSuccess = (data) => {
    if (isApiError(data)) throw new Error(String(errorMessage(data)));
};
const statusOf = (status) => {
    switch (String(status ?? '').trim().toLowerCase()) {
        case 'accept': return 'Completed';
        case 'reject': return 'Cancelled';
        // Unknown responses must never trigger a refund or false completion.
        default: return 'Pending';
    }
};
const failure = (message, rawResponse = null, providerOrderId = null) => ({
    success: false, providerOrderId, providerStatus: 'Cancelled', rawResponse, errorMessage: String(message),
});

class AlmotasimCardAdapter extends BaseProviderAdapter {
    constructor(provider, options = {}) {
        super(provider, options);
        const token = this._resolveToken();
        if (!provider.baseUrl) throw new Error('[AlmotasimCard] provider.baseUrl is required');
        if (!token) throw new Error('[AlmotasimCard] api token (apiToken / apiKey) is required');
        this._client = options.httpClient || axios.create({
            baseURL: provider.baseUrl.replace(/\/+$/, ''),
            timeout: options.timeoutMs ?? 180_000,
            headers: { 'api-token': token, Accept: 'application/json' },
        });
    }

    async getProducts() {
        const { data } = await this._client.get('/client/api/products');
        assertApiSuccess(data);
        if (!Array.isArray(data)) throw new Error('[AlmotasimCard] Invalid product list');
        return data.map((product) => {
            if (product.id == null) throw new Error('[AlmotasimCard] Missing product ID');
            const rules = product.qty_values;
            const quantities = Array.isArray(rules) ? rules.map(Number) : null;
            const minQty = quantities ? Math.min(...quantities) : Number(rules?.min ?? 1);
            const maxQty = quantities ? Math.max(...quantities) : Number(rules?.max ?? 1);
            if (!Number.isSafeInteger(minQty) || !Number.isSafeInteger(maxQty) || minQty < 1 || maxQty < minQty
                || quantities?.some((qty) => !Number.isSafeInteger(qty) || qty < 1)) {
                throw new Error(`[AlmotasimCard] Invalid quantity rules for product ${product.id}`);
            }
            return this._validateDTO({
                externalProductId: String(product.id), rawName: product.name, rawPrice: product.price,
                minQty, maxQty, isActive: product.available !== false,
                // Keep discrete quantity choices, required params and delivery metadata.
                rawPayload: product,
            });
        });
    }

    async getBalance() {
        const { data } = await this._client.get('/client/api/profile');
        assertApiSuccess(data);
        if (!data || !Number.isFinite(Number(data.balance)) || data.balance == null) {
            throw new Error('[AlmotasimCard] Invalid profile response');
        }
        return data;
    }

    async getContent(categoryId = 0) {
        const { data } = await this._client.get(`/client/api/content/${encodeURIComponent(categoryId)}`);
        assertApiSuccess(data);
        return data;
    }

    _readOrders(data) {
        assertApiSuccess(data);
        if (!Array.isArray(data?.orders)) throw new Error('[AlmotasimCard] Invalid order status response');
        return data.orders;
    }

    _orderResult(order) {
        const providerStatus = statusOf(order.status);
        return {
            providerOrderId: String(order.id), providerStatus,
            unifiedStatus: this.toUnifiedStatus(providerStatus), rawResponse: order,
        };
    }

    async checkOrders(orderIds = []) {
        if (!orderIds.length) return [];
        const { data } = await this._client.get('/client/api/check', {
            params: { orders: JSON.stringify(orderIds) },
        });
        const requested = new Set(orderIds.map(String));
        return this._readOrders(data)
            .filter((order) => order?.id != null && requested.has(String(order.id)))
            .map((order) => this._orderResult(order));
    }

    async checkOrder(orderId) {
        return (await this.checkOrders([orderId]))[0] ?? null;
    }

    async checkOrderByReference(referenceId) {
        const uuid = referenceUuid(referenceId);
        const { data } = await this._client.get('/client/api/check', {
            params: { orders: JSON.stringify([uuid]), uuid: 1 },
        });
        // The documented response omits order_uuid. A single result from a
        // single-UUID lookup identifies the order; don't require an extra field.
        const orders = this._readOrders(data);
        const order = orders.length === 1 && orders[0]?.id != null
            && (!orders[0].order_uuid || String(orders[0].order_uuid).toLowerCase() === uuid)
            ? orders[0] : null;
        return order ? { found: true, ...this._orderResult(order) } : { found: false, rawResponse: data };
    }

    async _recoverPlacement(uuid) {
        try {
            const result = await this.checkOrderByReference(uuid);
            if (result.found) return { success: true, ...result, errorMessage: null };
        } catch (_) { /* Existing cron retries lookup, then escalates to manual review. */ }
        return {
            success: true, providerOrderId: null, providerStatus: 'PLACEMENT_UNCERTAIN',
            rawResponse: { placement: 'uncertain', order_uuid: uuid }, errorMessage: null,
        };
    }

    async placeOrder(params = {}) {
        const productId = params.productId ?? params.externalProductId ?? params.providerProductId;
        const qty = Number(params.qty ?? params.quantity ?? params.amount ?? 1);
        if (!/^\d+$/.test(String(productId)) || Number(productId) <= 0) return failure('Almotasim Card product ID must be a positive integer');
        if (!Number.isSafeInteger(qty) || qty < 1) return failure('Almotasim Card quantity must be a positive integer');
        let uuid;
        try {
            const explicitUuid = params.order_uuid ?? params.orderUuid;
            if (explicitUuid != null && !UUID_V4.test(String(explicitUuid).trim())) return failure('Almotasim Card order_uuid must be a UUIDv4');
            uuid = referenceUuid(explicitUuid ?? params.referenceId);
        } catch (error) { return failure(error.message); }
        const fields = Object.fromEntries(Object.entries(params).filter(([key, value]) => !INTERNAL_KEYS.has(key) && value != null));
        const playerId = extractTargetId(params);
        if (playerId) fields.playerId = playerId;
        try {
            const { data } = await this._client.get(`/client/api/newOrder/${encodeURIComponent(productId)}/params`, {
                params: { ...fields, qty, order_uuid: uuid },
            });
            // A returned order takes precedence: it may already have been charged.
            if (data?.order?.id != null) {
                const result = this._orderResult({ ...data.order, status: data.order.status ?? data.status });
                if (result.providerStatus === 'Cancelled') return failure(data.message || 'Almotasim Card rejected the order', data, result.providerOrderId);
                return { success: true, ...result, rawResponse: data, errorMessage: null };
            }
            if (isApiError(data)) return failure(errorMessage(data), data);
            return this._recoverPlacement(uuid);
        } catch (error) {
            const body = error.response?.data;
            if (isApiError(body) && !body.order) return failure(errorMessage(body), body);
            return this._recoverPlacement(uuid);
        }
    }
}

module.exports = { AlmotasimCardAdapter };
