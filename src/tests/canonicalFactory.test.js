'use strict';

const { getProviderAdapter } = require('../modules/providers/adapters/adapter.factory');
const { CanonicalB2BAdapter } = require('../modules/providers/adapters/canonicalB2B.adapter');
const { RoyalCrownAdapter } = require('../modules/providers/adapters/royalCrown.adapter');

describe('provider adapter factory canonical precedence', () => {
    test('adapterType takes precedence without changing legacy slug resolution', () => {
        const canonical = getProviderAdapter({
            adapterType: 'canonical-b2b', slug: 'royal-crown', name: 'Royal Crown',
            baseUrl: 'https://upstream.example/client/api', apiToken: 'token',
        });
        expect(canonical).toBeInstanceOf(CanonicalB2BAdapter);

        const legacy = getProviderAdapter({ slug: 'royal-crown', name: 'Royal Crown', baseUrl: 'https://legacy.example', apiToken: 'token' });
        expect(legacy).toBeInstanceOf(RoyalCrownAdapter);
    });

    test('production mock-provider safeguard remains enabled', () => {
        const previous = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        expect(() => getProviderAdapter({ slug: 'not-registered', name: 'Unknown' }))
            .toThrow('Mock provider fallback is disabled in production');
        process.env.NODE_ENV = previous;
    });
});
