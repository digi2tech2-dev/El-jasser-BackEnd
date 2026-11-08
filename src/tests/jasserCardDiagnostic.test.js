'use strict';

const { reportProducts, diagnoseMissingProduct } = require('../../scripts/diagnose-jasser-catalog.cjs');

test('reports actual 1594 values and their types without other products or credentials', () => {
    const report = reportProducts([
        { id: 1594, name: 'Halo Star هالو ستار', product_type: 'range', qty_values: { min: 500000, max: 99999999.9999 }, apiToken: 'secret' },
        { id: 99, name: 'not requested', email: 'private' },
    ], ['secret']);
    expect(report[0]).toMatchObject({ id: 1594, qty_values: { min: 500000, max: 99999999.9999 }, qty_value_types: { type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' } } } });
    expect(report[1]).toEqual({ id: '1537', found: false });
    expect(JSON.stringify(report)).not.toMatch(/secret|not requested|private/);
});

test('present 1537 requires no extra supplier call', async () => {
    const adapter = { _client: { get: jest.fn() } };
    expect(await diagnoseMissingProduct(adapter, [{ id: 1537 }], '1537')).toEqual({ reason: 'present_in_full_catalog' });
    expect(adapter._client.get).not.toHaveBeenCalled();
});

test('distinguishes filtered-only 1537, with names and rule values safely redacted', async () => {
    const adapter = { _client: { get: jest.fn().mockResolvedValue({ data: [{ id: 1537, name: 'secret', available: false, qty_values: null }] }) } };
    const result = await diagnoseMissingProduct(adapter, [], '1537', ['secret']);
    expect(result).toMatchObject({ reason: 'omitted_from_full_catalog_but_present_in_filtered_lookup', available: false, product: { name: '[REDACTED]' } });
    expect(adapter._client.get).toHaveBeenCalledWith('/client/api/products', { params: { products_id: '1537' } });
});

test('absence in both lists does not invent deletion or an account permission diagnosis', async () => {
    const adapter = { _client: { get: jest.fn().mockResolvedValue({ data: [] }) } };
    expect(await diagnoseMissingProduct(adapter, [], '1537')).toEqual({ reason: 'absent_from_full_and_filtered_catalogs', supplier_confirmation_required: true });
});

test('supplier errors expose only known numeric codes, never account data or messages', async () => {
    const adapter = { _client: { get: jest.fn().mockResolvedValue({ data: { code: 109, message: 'private', email: 'private' } }) } };
    expect(await diagnoseMissingProduct(adapter, [], '1537')).toEqual({ reason: 'supplier_did_not_return_a_product_list', provider_error_code: 109 });
});

test('HTTP failure does not expose tokens, URI, Axios config or stack', async () => {
    const adapter = { _client: { get: jest.fn().mockRejectedValue({ message: 'private', response: { status: 401, data: 'private' }, config: { headers: { 'api-token': 'private' } } }) } };
    expect(await diagnoseMissingProduct(adapter, [], '1537')).toEqual({ reason: 'filtered_lookup_failed', http_status: 401 });
});
