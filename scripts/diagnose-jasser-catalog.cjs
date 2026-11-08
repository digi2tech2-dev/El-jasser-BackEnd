'use strict';

// Read-only diagnostic: node scripts/diagnose-jasser-catalog.cjs
const path = require('path');
const IDS = ['1594', '1537'];
const ALIASES = ['jasser-card', 'jasser card', 'jassercard', '\u062c\u0627\u0633\u0631 \u0643\u0627\u0631\u062f'];

const typeTree = (value) => {
    if (value === null) return { type: 'null' };
    if (Array.isArray(value)) return { type: 'array', items: value.map(typeTree) };
    if (typeof value === 'object') return { type: 'object', properties: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeTree(item)])) };
    return { type: typeof value };
};
const safeValue = (value, secrets) => {
    if (typeof value === 'string') return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
    if (Array.isArray(value)) return value.map((item) => safeValue(item, secrets));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [safeValue(key, secrets),
        /token|api.?key|authorization|cookie|secret|password/i.test(key) ? '[REDACTED]' : safeValue(item, secrets)]));
    return value;
};

const diagnoseMissingProduct = async (adapter, data, id, secrets = []) => {
    if (!Array.isArray(data)) throw new Error('Unexpected product list response');
    if (data.some((product) => product && String(product.id) === String(id))) return { reason: 'present_in_full_catalog' };
    try {
        const { data: filtered } = await adapter._client.get('/client/api/products', { params: { products_id: String(id) } });
        if (!Array.isArray(filtered)) {
            const code = Number(filtered?.code);
            const knownCodes = [100, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 120, 121, 122, 123, 130, 500];
            return { reason: 'supplier_did_not_return_a_product_list', ...(knownCodes.includes(code) ? { provider_error_code: code } : {}) };
        }
        const product = filtered.find((item) => item && String(item.id) === String(id));
        if (!product) return { reason: 'absent_from_full_and_filtered_catalogs', supplier_confirmation_required: true };
        return {
            reason: 'omitted_from_full_catalog_but_present_in_filtered_lookup',
            product: reportProducts([product], secrets).find((item) => String(item.id) === String(id)),
            ...(typeof product.available === 'boolean' ? { available: product.available } : {}),
        };
    } catch (error) {
        const status = error.response?.status;
        return { reason: 'filtered_lookup_failed', ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { http_status: status } : {}) };
    }
};
const reportProducts = (data, secrets = []) => {
    if (!Array.isArray(data)) throw new Error('Unexpected product list response');
    return IDS.map((id) => {
        const matches = data.filter((product) => product && String(product.id) === id);
        if (matches.length > 1) throw new Error('Duplicate target product ID');
        if (!matches.length) return { id, found: false };
        const product = matches[0];
        return safeValue({
            id: product.id,
            name: product.name,
            ...(product.product_type !== undefined ? { product_type: product.product_type } : {}),
            qty_values: product.qty_values === undefined ? '[MISSING]' : product.qty_values,
            qty_value_types: typeTree(product.qty_values),
        }, secrets);
    });
};

const main = async () => {
    let connection;
    let stage = 'configuration';
    try {
        if (process.argv.length > 2) throw new Error('No options are supported');
        require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });
        if (!process.env.MONGO_URI) throw new Error('Missing MongoDB configuration');
        const mongoose = require('mongoose');
        stage = 'read-only provider lookup';
        // No app/server import, model writes, index creation, jobs or sync engine.
        connection = mongoose.createConnection(process.env.MONGO_URI, {
            autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000,
        });
        await connection.asPromise();
        const providers = await connection.db.collection('providers').find({
            deletedAt: null,
            $or: [
                { adapterType: { $in: ALIASES } },
                { slug: { $in: ALIASES } },
                { name: { $in: ALIASES } },
            ],
        }, { projection: { baseUrl: 1, apiToken: 1, apiKey: 1, adapterType: 1, slug: 1, name: 1 } })
            .collation({ locale: 'en', strength: 2 }).limit(2).toArray();
        if (providers.length !== 1) throw new Error('Expected exactly one Jasser provider');
        const provider = providers[0];
        const { getProviderAdapter } = require('../src/modules/providers/adapters/adapter.factory');
        const { JasserCardAdapter } = require('../src/modules/providers/adapters/jasserCard.adapter');
        const adapter = getProviderAdapter(provider, { strict: true, timeoutMs: 30000 });
        if (!(adapter instanceof JasserCardAdapter)) throw new Error('Provider does not resolve to Jasser');
        stage = 'GET product catalog';
        // Exactly the adapter's HTTP client, header, URL and endpoint. Read raw
        // data before getProducts() rejects an unrecognized quantity format.
        const { data } = await adapter._client.get('/client/api/products');
        stage = 'target product extraction';
        const secrets = [provider.apiToken, provider.apiKey, process.env.MONGO_URI];
        const report = reportProducts(data, secrets);
        const missing1537 = await diagnoseMissingProduct(adapter, data, '1537', secrets);
        process.stdout.write(`${JSON.stringify({ products: report, product_1537_diagnosis: missing1537 }, null, 2)}\n`);
    } catch (_) {
        // Never print error.message, Axios config/headers, response body or URI.
        process.stderr.write(`Jasser diagnostic failed during ${stage}. Credentials and response details suppressed.\n`);
        process.exitCode = 1;
    } finally {
        if (connection) {
            try { await connection.close(); } catch (_) { process.exitCode = 1; }
        }

    }
};

if (require.main === module) main();
module.exports = { reportProducts, typeTree, diagnoseMissingProduct };
