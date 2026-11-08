'use strict';

// No global database setup/teardown. These suites use in-memory documents and
// mocked persistence/adapters, so running them never connects to MongoDB.
module.exports = {
    testEnvironment: 'node',
    testMatch: [
        '**/src/tests/providerSafety.test.js',
        '**/src/tests/providerSyncScheduling.test.js',
        '**/src/tests/adapters.test.js',
        '**/src/tests/canonicalFactory.test.js',
        '**/src/tests/canonicalB2BAdapter.test.js',
        '**/src/tests/jasserCardAdapter.test.js',
        '**/src/tests/jasserCardCatalogSync.test.js',
        '**/src/tests/jasserCardDiagnostic.test.js',
        '**/src/tests/almotasimCardAdapter.test.js',
        '**/src/tests/brandOneCardAdapter.test.js',
    ],
    clearMocks: true,
    testTimeout: 10000,
};
