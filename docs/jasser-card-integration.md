# Jasser Card

This integration is isolated in `jasserCard.adapter.js`. Existing supplier adapters,
wallet logic and order routing are unchanged. The factory only adds new aliases:
`jasser-card`, `jasser card`, `jassercard`, and `جاسر كارد`.

## Configure

Create a **new** supplier through the admin suppliers screen or authenticated
`POST /api/admin/providers`. Do not edit an existing supplier:

```json
{
  "name": "Jasser Card",
  "slug": "jasser-card",
  "adapterType": "jasser-card",
  "baseUrl": "https://www.jasser-card.net",
  "apiToken": "SET_PRIVATELY_IN_ADMIN",
  "isActive": true,
  "syncInterval": 0
}
```

Keep automatic sync disabled initially. The real token belongs only in the server
configuration; never commit it or embed it in frontend code. The adapter sends it
in the `api-token` header and disables redirects to avoid forwarding it.

1. Use `POST /api/admin/providers/:id/test-connection` and
   `GET /api/admin/providers/:id/balance` to verify the account and allowed server IP.
2. Sync **only this supplier** with `POST /api/providers/:id/sync`.
3. Review its products at `GET /api/providers/:id/products`, then publish selected
   products using the existing admin workflow with automatic execution.
4. Configure required customer fields from each product's `params`. For example,
   map `player_id` to `playerId` in `providerMapping`; map any additional fields to
   the supplier's exact parameter keys. Do not use internal keys such as
   `referenceId`, `quantity`, `order_uuid`, or `productId` as customer field names.
5. Verify the account's price currency before publishing; the supplied API examples
   do not identify it. Prices are passed through without an assumed exchange rate.
6. Run one controlled live order and check its final status before publishing more
   products or enabling periodic sync. A live order can charge the supplier account.

Quantity rules and product metadata are preserved in `rawPayload`. Null quantity
rules mean exactly one; range bounds become `minQty`/`maxQty`. Discrete choices
remain in `rawPayload.qty_values`; configure the product UI accordingly. The
supplier validates discrete choices and responds with a rejection for invalid ones.

### Catalog quantity correction — 2026-11-09

The server diagnostic identified product **1594**, `Halo Star هالو ستار`, with
`product_type: "range"` and numeric `qty_values: { min: 500000, max: 99999999.9999 }`.
The old adapter rejected the finite decimal maximum because it required a safe
integer. The adapter now retains finite positive range maxima without rounding;
minima remain positive safe integers and cannot exceed the maximum. Fixed-quantity
and discrete-choice products retain their interpretation. Customer purchase
quantities must still be positive safe integers; a decimal catalog ceiling never
permits decimal purchases.

Published Jasser product bounds use the same validation and retain the decimal
maximum. The shared sync engine uses this Jasser-only opt-in hook; other suppliers
retain their existing validation. An invalid product rejects the entire fetched
catalog before any writes. If an upsert fails, Jasser sync raises an explicit
incomplete-catalog error and skips publication. Some successful raw upserts may
already exist at that point; the batch is not a database transaction.

Missing Jasser products are **never deactivated solely because they are absent**
from the supplier response. This includes product **1537**, which the server
diagnostic did not find in the current full catalog. Explicit availability values
on products that are returned continue to be stored normally.

To investigate 1537 without database writes, use this read-only diagnostic on the
server (it reads `.env` and the stored provider configuration):

```bash
cd /srv/DIGI-TECH/EL-JASSER/backend
node scripts/diagnose-jasser-catalog.cjs
```

It uses the adapter's existing client to fetch the full product list. If 1537 is
absent, it also requests `GET /client/api/products?products_id=1537`. The report
distinguishes full-list omission, absence from both lists, known supplier error
codes and HTTP failures. Neither absence nor an error alone proves deletion or
loss of account access; those causes require supplier confirmation. Only the
requested product fields/types and safe diagnostic labels are printed, never
credentials, account profiles, headers or raw error messages. No sync is executed.

The database-free regression suite is:

```bash
node node_modules/jest/bin/jest.js --config jest.provider-safety.config.js --runInBand
```

Verification on 2026-11-09: **364 tests passed across 10 suites** in the
database-free regression suite. The full local suite (disposable MongoDB only)
completed with **1162 passed, 1 failed; 48 suites passed, 1 failed**. The sole
failure is the previously documented `brandOneCardSync.test.js` unmocked
`providerproducts.findOne()` timeout, unrelated to the Jasser changes. No supplier
API calls or production database writes were performed during these tests.

## Order safety

Each platform order number deterministically derives a UUIDv4-shaped idempotency
key in a Jasser-specific namespace. The same order retains that UUID across retries
and restarts. Never generate a fresh reference for an existing purchase.

`accept` completes an order, `wait` keeps it processing, and `reject` fails it through
the existing refund flow. Unknown statuses remain pending. Delivery codes remain
in the stored supplier response. Network failures, malformed placement responses,
and unknown errors 114/500 trigger a lookup by UUID rather than another purchase.
Unresolved purchases remain `PLACEMENT_UNCERTAIN`; the existing cron checks the
same reference and eventually escalates unresolved cases to manual review.

## Verification

```powershell
npm.cmd test -- --runTestsByPath src/tests/jasserCardAdapter.test.js src/tests/jasserCardIntegration.test.js src/tests/adapters.test.js src/tests/almotasimCardAdapter.test.js src/tests/fulfillment.test.js src/tests/orderPolling.test.js
```

Tests simulate supplier HTTP, including an actual local HTTP request to check
header privacy and query encoding. Integration tests use the disposable test
database for catalog isolation, routing, refunds and recovery. They never send
a paid order to the real supplier. Account credentials and a live check are still
required to validate production access and delivery.

### Local verification result — 2026-11-08

- Targeted adapters, fulfillment, polling and Jasser integration: **269 passed**.
- Full platform run: **44 suites passed, 1 suite failed; 1062 tests passed, 1 failed**.
- The failing existing test is `brandOneCardSync.test.js`, "syncs EGP into USD
  and propagates USD prices with markup to published products". Its unmocked
  `ProviderProduct.findById()` call buffers without a database connection and
  times out. Re-running it with the original factory from `HEAD`, excluding the
  Jasser registration, reproduces the same failure (3 passed, 1 failed).
- No production database was accessed and no real supplier order was submitted.
