'use strict';

const axios = require('axios');
const { BaseProviderAdapter } = require('./base.adapter');
const { extractTargetId } = require('./providerParams.helper');
const { normalizeProviderDecimalPrice } = require('../../../shared/utils/decimalPrecision');

const DEFAULT_TIMEOUT_MS = 180_000;
const PROVIDER_NAME = 'DealerApi';
const SUCCESS_CODE = '200';

const DEALER_DYNAMIC_APPS = Object.freeze([
    Object.freeze({
        key: 'karak',
        providerKeys: Object.freeze(['karak', 'karak-chat', 'karak chat', 'karakchat']),
        product: Object.freeze({
            id: 'karak_dynamic_coins',
            name: 'Karak Dynamic Coins (Any Amount)',
            price: 0.00001,
            minQty: 1,
            maxQty: 5000000,
            currency: 'USD',
        }),
    }),
    Object.freeze({
        key: 'ibulala',
        providerKeys: Object.freeze(['ibulala', 'ibulala-chat', 'ibulala chat', 'ibulalachat']),
        product: Object.freeze({
            id: 'ibulala_dynamic_coins',
            name: 'Ibulala Dynamic Coins (Any Amount)',
            price: '0.00000000001',
            minQty: 1,
            maxQty: 500000000,
            currency: 'USD',
        }),
    }),
]);

const KARAK_DYNAMIC_APP = DEALER_DYNAMIC_APPS.find((app) => app.key === 'karak');
const KARAK_DYNAMIC_PRODUCT = KARAK_DYNAMIC_APP.product;
const KARAK_DYNAMIC_PRODUCT_ID = KARAK_DYNAMIC_PRODUCT.id;

const ERROR_MESSAGES = Object.freeze({
    131: 'Dealer API rejected the request. Check secretKey and request parameters.',
    138: 'Dealer API rejected the sale. Check target user ID, coin amount, and account balance.',
});

const normalizeProviderKey = (value) => String(value ?? '').toLowerCase().trim();

const compactProviderKey = (value) => normalizeProviderKey(value).replace(/[^a-z0-9]/g, '');

const toProviderMatchKeys = (value) => {
    const normalized = normalizeProviderKey(value);
    const compact = compactProviderKey(value);

    return [normalized, compact].filter(Boolean);
};

const buildProviderKeySet = (providerKeys = []) => new Set(
    providerKeys.flatMap(toProviderMatchKeys)
);

const DEALER_DYNAMIC_APP_MATCHERS = DEALER_DYNAMIC_APPS.map((app) => Object.freeze({
    app,
    providerKeys: buildProviderKeySet(app.providerKeys),
}));

const getProviderCandidates = (provider = {}) => {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
        return [provider];
    }

    return [provider.code, provider.slug, provider.name, provider.providerCode];
};

const getDealerDynamicApp = (provider = {}) => {
    const candidateKeys = getProviderCandidates(provider).flatMap(toProviderMatchKeys);

    return DEALER_DYNAMIC_APP_MATCHERS.find(({ providerKeys }) => (
        candidateKeys.some((key) => providerKeys.has(key))
    ))?.app ?? null;
};

const getDealerDynamicProduct = (provider = {}) => getDealerDynamicApp(provider)?.product ?? null;

const getDealerDynamicProductById = (productId) => {
    const normalizedProductId = String(productId ?? '').trim();

    return DEALER_DYNAMIC_APPS.find((app) => app.product.id === normalizedProductId)?.product ?? null;
};

const isDealerDynamicProvider = (provider = {}) => Boolean(getDealerDynamicApp(provider));

const isKarakProvider = (provider = {}) => getDealerDynamicApp(provider)?.key === 'karak';

const buildDealerDynamicProductDto = (appOrProduct) => {
    const product = appOrProduct?.product ?? appOrProduct;

    if (!product?.id || !product?.name) {
        throw new Error(`[${PROVIDER_NAME}] Dealer dynamic product config is invalid`);
    }

    const price = normalizeProviderDecimalPrice(product.price);

    return {
        ...product,
        price,
        externalProductId: product.id,
        rawName: product.name,
        rawPrice: price,
        costPrice: price,
        providerPrice: price,
        minQty: product.minQty,
        maxQty: product.maxQty,
        isActive: true,
        rawPayload: {
            ...product,
            price,
            product_id: product.id,
            product_name: product.name,
            product_price: price,
        },
    };
};

const buildKarakDynamicProductDto = () => buildDealerDynamicProductDto(KARAK_DYNAMIC_APP);

class DealerApiError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'DealerApiError';
        this.code = details.code ?? null;
        this.statusCode = details.statusCode ?? null;
        this.providerBody = details.providerBody ?? null;
    }
}

const buildClient = (baseURL, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    const client = axios.create({
        baseURL,
        timeout: timeoutMs,
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
    });

    client.interceptors.response.use(
        (res) => res,
        (err) => {
            const status = err.response?.status;
            const body = err.response?.data;
            const message = body?.message || body?.msg || body?.error || err.message || 'Unknown provider error';

            return Promise.reject(new DealerApiError(
                `[${PROVIDER_NAME}] HTTP ${status ?? 'NETWORK'}: ${message}`,
                {
                    statusCode: status ?? null,
                    providerBody: body ?? null,
                }
            ));
        }
    );

    return client;
};

const getProviderMessage = (payload, fallback = 'Dealer API request failed.') => {
    const code = String(payload?.code ?? '').trim();

    return payload?.message
        || payload?.msg
        || payload?.error
        || ERROR_MESSAGES[code]
        || fallback;
};

const assertSuccess = (payload, operation) => {
    const code = String(payload?.code ?? '').trim();

    if (code === SUCCESS_CODE) return payload;

    throw new DealerApiError(
        `[${PROVIDER_NAME}] ${operation} failed with code ${code || 'UNKNOWN'}: ${getProviderMessage(payload)}`,
        {
            code: code || null,
            providerBody: payload,
        }
    );
};

class DealerApiAdapter extends BaseProviderAdapter {
    constructor(provider, options = {}) {
        super(provider, options);

        const baseUrl = options.baseUrl || provider.baseUrl;
        const secretKey = options.secretKey
            || this._resolveToken()
            || provider.secretKey
            || provider.secret;

        if (!baseUrl) throw new Error(`[${PROVIDER_NAME}] provider.baseUrl is required`);
        if (!secretKey) throw new Error(`[${PROVIDER_NAME}] secretKey (apiToken / apiKey) is required`);

        this.secretKey = secretKey;
        this._client = buildClient(baseUrl, options.timeoutMs);
    }

    /**
     * GET /dealer/account?secretKey={secretKey}
     *
     * @returns {Promise<{ coinBalance: number, rawResponse: object }>}
     */
    async checkBalance() {
        const { data } = await this._client.get('/dealer/account', {
            params: { secretKey: this.secretKey },
        });

        assertSuccess(data, 'checkBalance');

        return {
            coinBalance: Number(data.data?.coinBalance ?? 0),
            rawResponse: data,
        };
    }

    async getBalance() {
        const balance = await this.checkBalance();

        return {
            balance: balance.coinBalance,
            coinBalance: balance.coinBalance,
            rawResponse: balance.rawResponse,
        };
    }

    /**
     * GET /dealer/user-info?secretKey={secretKey}&userId={userId}
     *
     * @param {string|number} userId
     * @returns {Promise<{ uid: string, nickName: string, avatar: string|null, rawResponse: object }>}
     */
    async validateUser(userId) {
        if (!userId) throw new Error(`[${PROVIDER_NAME}] userId is required`);

        const { data } = await this._client.get('/dealer/user-info', {
            params: {
                secretKey: this.secretKey,
                userId,
            },
        });

        assertSuccess(data, 'validateUser');

        return {
            uid: String(data.data?.uid ?? userId),
            nickName: data.data?.nickName ?? '',
            avatar: data.data?.avatar ?? null,
            rawResponse: data,
        };
    }

    /**
     * POST /dealer/sale?secretKey={secretKey}&toUserId={userId}&coins={coins}
     *
     * Query-string parameters are required even though this is a POST.
     *
     * @param {Object} params
     * @param {string|number} params.userId
     * @param {number} params.coins
     * @returns {Promise<{ success: boolean, rawResponse: object }>}
     */
    async processSale(params = {}) {
        const userId = extractTargetId(params);
        const coins = params.coins ?? params.amount ?? params.quantity;
        const toUserId = Number(userId);
        const coinAmount = Number(coins);

        if (!userId) throw new Error(`[${PROVIDER_NAME}] userId is required`);
        if (!Number.isFinite(toUserId) || toUserId <= 0) {
            throw new Error(`[${PROVIDER_NAME}] toUserId must be a positive number`);
        }
        if (!Number.isFinite(coinAmount) || coinAmount <= 0) {
            throw new Error(`[${PROVIDER_NAME}] coins must be a positive number`);
        }

        const { data } = await this._client.post('/dealer/sale', null, {
            params: {
                secretKey: this.secretKey,
                toUserId,
                coins: coinAmount,
            },
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        });

        assertSuccess(data, 'processSale');

        return {
            success: true,
            rawResponse: data,
        };
    }

    async placeOrder(params = {}) {
        try {
            const targetId = extractTargetId(params);
            if (!targetId) {
                return {
                    success: false,
                    providerOrderId: null,
                    providerStatus: 'Cancelled',
                    unifiedStatus: this.toUnifiedStatus('Cancelled'),
                    rawResponse: {
                        status: 'ERROR',
                        msg: 'Missing provider target/player ID',
                    },
                    errorCode: null,
                    errorMessage: 'Missing provider target/player ID',
                };
            }

            const providerProductId = params.providerProductId ?? params.externalProductId ?? params.productId;
            const dynamicProduct = getDealerDynamicProduct(this.provider);
            const isDealerDynamicProduct = Boolean(dynamicProduct)
                && String(providerProductId || '').trim() === dynamicProduct.id;
            const saleParams = isDealerDynamicProduct
                ? {
                    toUserId: targetId,
                    coins: Number(params.quantity),
                }
                : {
                    userId: targetId,
                    coins: params.coins ?? params.amount ?? params.quantity,
                };

            const sale = await this.processSale(saleParams);

            return {
                success: true,
                providerOrderId: params.referenceId ?? null,
                providerStatus: 'Completed',
                unifiedStatus: this.toUnifiedStatus('Completed'),
                rawResponse: sale.rawResponse,
                errorMessage: null,
            };
        } catch (err) {
            return {
                success: false,
                providerOrderId: null,
                providerStatus: 'Cancelled',
                unifiedStatus: this.toUnifiedStatus('Cancelled'),
                rawResponse: err.providerBody ?? { message: err.message },
                errorCode: err.code ?? null,
                errorMessage: err.message,
            };
        }
    }

    /**
     * GET /dealer/list?secretKey={secretKey}&page={page}
     *
     * @param {number} [page=1]
     * @returns {Promise<{ rows: Array, page: number, rawResponse: object }>}
     */
    async getTransactionList(page = 1) {
        const { data } = await this._client.get('/dealer/list', {
            params: {
                secretKey: this.secretKey,
                page,
            },
        });

        assertSuccess(data, 'getTransactionList');

        return {
            rows: Array.isArray(data.data?.rows) ? data.data.rows : [],
            page: Number(page),
            rawResponse: data,
        };
    }

    async listTransactions(page = 1) {
        return this.getTransactionList(page);
    }

    async getProducts() {
        const dynamicApp = getDealerDynamicApp(this.provider);

        if (dynamicApp) {
            return [buildDealerDynamicProductDto(dynamicApp)];
        }

        return [];
    }

    async checkOrder(orderId) {
        return {
            providerOrderId: String(orderId),
            providerStatus: 'Completed',
            unifiedStatus: this.toUnifiedStatus('Completed'),
            rawResponse: null,
        };
    }

    async checkOrders(orderIds = []) {
        return orderIds.map((orderId) => ({
            providerOrderId: String(orderId),
            providerStatus: 'Completed',
            unifiedStatus: this.toUnifiedStatus('Completed'),
            rawResponse: null,
        }));
    }
}

module.exports = {
    DealerApiAdapter,
    DealerApiError,
    DEALER_DYNAMIC_APPS,
    getDealerDynamicApp,
    getDealerDynamicProduct,
    getDealerDynamicProductById,
    buildDealerDynamicProductDto,
    isDealerDynamicProvider,
    KARAK_DYNAMIC_PRODUCT_ID,
    KARAK_DYNAMIC_PRODUCT,
    buildKarakDynamicProductDto,
    isKarakProvider,
};
