'use strict';

// Brand One Card (api.brand-one-card.com), independent of brand1-card.
const axios = require('axios');
const { BaseProviderAdapter } = require('./base.adapter');
const currencyConverter = require('../../../services/currencyConverter.service');
const { divide } = require('../../../shared/utils/decimalPrecision');
const { BusinessRuleError } = require('../../../shared/errors/AppError');

const INTERNAL_KEYS = new Set([
    'productId', 'externalProductId', 'providerProductId', 'providerId',
    'quantity', 'amount', 'qty', 'referenceId', 'orderUuid', 'order_uuid',
    'price', 'basePrice', 'providerPrice', 'walletBalance', 'balance', 'currency',
]);

const normaliseStatus = (status) => {
    switch (String(status ?? '').trim().toLowerCase()) {
        case 'accept': return 'Completed';
        case 'reject': return 'Cancelled';
        default: return 'Pending';
    }
};

const assertApiSuccess = (data) => {
    if (String(data?.status).toUpperCase() === 'ERROR') {
        const error = new Error(`[BrandOneCard] ${data.msg || data.detail || 'API request failed'} (code ${data.code ?? 'unknown'})`);
        error.providerBody = data;
        throw error;
    }
};

const failure = (message, rawResponse, providerOrderId = null) => ({
    success: false, providerOrderId, providerStatus: 'Cancelled', rawResponse, errorMessage: message,
});

class BrandOneCardAdapter extends BaseProviderAdapter {
    constructor(provider, options = {}) {
        super(provider, options);
        const token = this._resolveToken();
        if (!provider.baseUrl) throw new Error('[BrandOneCard] provider.baseUrl is required');
        if (!token) throw new Error('[BrandOneCard] api token (apiToken / apiKey) is required');
        this._client = options.httpClient || axios.create({
            baseURL: provider.baseUrl.replace(/\/+$/, ''),
            timeout: options.timeoutMs ?? 180_000,
            headers: { 'api-token': token, Accept: 'application/json' },
        });
    }

    async getProducts() {
        const { data } = await this._client.get('/client/api/products');
        assertApiSuccess(data);
        if (!Array.isArray(data)) throw new Error('[BrandOneCard] Invalid product list');
        // Prices are denominated in the account currency. The rest of the
        // platform (sync, live price checks and publishing) expects USD DTOs.
        // Resolve each rate once per catalog, before any products are written.
        const currencyCode = (value) => String(value ?? '').trim().toUpperCase();
        let accountCurrency;
        if (data.some((product) => !currencyCode(product.currency))) {
            accountCurrency = currencyCode((await this.getBalance())?.currency);
            if (!accountCurrency) {
                throw new BusinessRuleError('Brand One Card لم يرجع عملة الحساب؛ تعذر تحديد عملة أسعار المنتجات.', 'PROVIDER_CURRENCY_MISSING');
            }
        }
        const rates = new Map([['USD', 1]]);
        for (const product of data) {
            const currency = currencyCode(product.currency) || accountCurrency;
            if (rates.has(currency)) continue;
            let rate;
            try {
                rate = await currencyConverter.getConversionRate(currency);
            } catch (error) {
                if (!['NOT_FOUND', 'CURRENCY_INACTIVE', 'MISSING_CURRENCY_CODE'].includes(error.code)) throw error;
                throw new BusinessRuleError(`تعذر تحويل أسعار Brand One Card من ${currency} إلى USD. أضف العملة وفعّلها وحدد سعر صرفها في إعدادات العملات.`, 'PROVIDER_CURRENCY_RATE_UNAVAILABLE');
            }
            if (!Number.isFinite(Number(rate)) || Number(rate) <= 0) {
                throw new BusinessRuleError(`سعر صرف ${currency} غير صالح؛ يجب أن يكون أكبر من صفر.`, 'PROVIDER_CURRENCY_RATE_UNAVAILABLE');
            }
            rates.set(currency, rate);
        }
        return data.map((product) => {
            if (product.id == null) throw new Error('[BrandOneCard] Product ID is missing');
            const currency = currencyCode(product.currency) || accountCurrency;
            const rate = rates.get(currency);
            const minQty = Number(product.qty_values?.min ?? 1);
            const maxQty = Number(product.qty_values?.max ?? 1);
            if (!Number.isInteger(minQty) || !Number.isInteger(maxQty) || minQty < 1 || maxQty < minQty) {
                throw new Error(`[BrandOneCard] Invalid quantity range for product ${product.id}`);
            }
            const dto = this._validateDTO({
                externalProductId: String(product.id), rawName: product.name,
                rawPrice: product.price, minQty, maxQty,
                isActive: product.available !== false, rawPayload: product,
            });
            // Divide as decimal strings so micro-prices never round to zero.
            dto.rawPrice = divide(dto.rawPrice, rate);
            return dto;
        });
    }

    async getBalance() {
        const { data } = await this._client.get('/client/api/profile');
        assertApiSuccess(data);
        return data;
    }

    async getContent(categoryId = 0) {
        const { data } = await this._client.get(`/client/api/content/${encodeURIComponent(categoryId)}`);
        assertApiSuccess(data);
        return data;
    }

    _readOrders(data) {
        assertApiSuccess(data);
        if (data?.status !== 'OK' || !Array.isArray(data.data)) {
            throw new Error('[BrandOneCard] Invalid order status response');
        }
        return data.data;
    }

    _orderResult(order) {
        const providerStatus = normaliseStatus(order.status);
        return {
            providerOrderId: String(order.order_id), providerStatus,
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
            .filter((order) => order?.order_id != null && requested.has(String(order.order_id)))
            .map((order) => this._orderResult(order));
    }

    async checkOrder(orderId) {
        return (await this.checkOrders([orderId]))[0] ?? null;
    }

    // Used by the existing fulfillment cron to recover lost placement responses.
    async checkOrderByReference(referenceId) {
        if (!referenceId) throw new Error('[BrandOneCard] referenceId is required');
        const { data } = await this._client.get('/client/api/check', {
            params: { uuid: 1, orders: JSON.stringify([String(referenceId)]) },
        });
        const order = this._readOrders(data).find((item) => (
            item?.order_id != null && String(item.order_uuid) === String(referenceId)
        ));
        return order ? { found: true, ...this._orderResult(order) } : { found: false, rawResponse: data };
    }

    async _recoverPlacement(referenceId) {
        try {
            const result = await this.checkOrderByReference(referenceId);
            if (result.found) {
                return { success: true, ...result, errorMessage: null };
            }
        } catch (_) { /* Cron retries reference lookup; never refund an uncertain dispatch. */ }
        return {
            success: true, providerOrderId: null, providerStatus: 'PLACEMENT_UNCERTAIN',
            rawResponse: { placement: 'uncertain', order_uuid: referenceId }, errorMessage: null,
        };
    }

    async placeOrder(params = {}) {
        const productId = params.productId ?? params.externalProductId ?? params.providerProductId;
        const qty = Number(params.qty ?? params.quantity ?? params.amount ?? 1);
        // Required rather than randomly regenerated: retries must use the same UUID.
        const orderUuid = String(params.order_uuid ?? params.orderUuid ?? params.referenceId ?? '').trim();
        if (productId == null || !/^\d+$/.test(String(productId)) || Number(productId) <= 0) {
            return failure('BrandOneCard product ID must be a positive integer', null);
        }
        if (!Number.isSafeInteger(qty) || qty < 1) return failure('BrandOneCard quantity must be a positive integer', null);
        if (!orderUuid) return failure('BrandOneCard referenceId / order_uuid is required', null);

        // Customer fields already use providerMapping's exact query keys. Some
        // products need multiple fields, and code products may need none.
        const fields = Object.fromEntries(Object.entries(params).filter(([key, value]) => (
            !INTERNAL_KEYS.has(key) && value != null
        )));
        try {
            const { data } = await this._client.get(
                `/client/api/newOrder/${encodeURIComponent(productId)}/params`,
                { params: { ...fields, qty, order_uuid: orderUuid } }
            );
            assertApiSuccess(data);
            const order = data?.data;
            // A malformed success response may hide an order that was charged.
            if (data?.status !== 'OK' || order?.order_id == null) return this._recoverPlacement(orderUuid);
            const result = this._orderResult(order);
            if (result.providerStatus === 'Cancelled') {
                return failure(order.msg || 'BrandOneCard rejected the order', data, result.providerOrderId);
            }
            return { success: true, ...result, rawResponse: data, errorMessage: null };
        } catch (error) {
            const body = error.providerBody ?? error.response?.data;
            // Only an explicit API error guarantees that nothing was charged.
            if (String(body?.status).toUpperCase() === 'ERROR') {
                return failure(body.msg || body.detail || error.message, body);
            }
            return this._recoverPlacement(orderUuid);
        }
    }
}

module.exports = { BrandOneCardAdapter };
