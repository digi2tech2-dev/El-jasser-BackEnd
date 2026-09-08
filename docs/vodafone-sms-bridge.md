# Vodafone Cash SMS Bridge — KA observe mode

The KA webhook is:

```text
${APP_URL}/api/payment-events/vodafone-cash
```

`APP_URL` must be the deployed KA backend origin. This repository does not
contain an nginx configuration or a public KA domain, so an operator must set
the real deployed value before configuring Android. Do not use a Kanz Coins URL.

## Required environment

```env
VODAFONE_SMS_BRIDGE_ENABLED=true
VODAFONE_SMS_HMAC_SECRET=<new KA-only random secret>
VODAFONE_SMS_AUTO_APPROVE=false
VODAFONE_SMS_INSTAPAY_AUTO_APPROVE=false
VODAFONE_SMS_DEVICE_ID=ka-vf-01
VODAFONE_SMS_MAX_EVENT_AGE_MINUTES=1440
```

With a missing secret the enabled endpoint fails closed with HTTP 503. Never
put this secret in the frontend or reuse a secret from another application.

## Android contract

The Android forwarder POSTs its JSON as UTF-8 and calculates an HMAC-SHA-256
hex digest over the *exact raw request body bytes*. It sends:

```text
X-Bridge-Id: ka-vf-01
X-Signature: <hex HMAC-SHA-256>
```

The endpoint accepts only `VF-Cash` (case/spacing/hyphen-normalized) messages.
It is not a customer-authenticated route.

Suggested forwarder filter:

```regex
(?i)(تم استلام مبلغ|Received\s+EGP)
```

Suggested payload:

```json
{
  "from": "%from%",
  "text": "%text%",
  "sentStamp": %sentStamp%,
  "receivedStamp": %receivedStamp%,
  "sim": "%sim%",
  "version": "%version%",
  "battery": %battery%,
  "network": "%network%"
}
```

## Observe-mode behaviour

Each authenticated message is retained in `PaymentEvent`, including the raw SMS
for restricted audit access. Parsed Vodafone wallet events retain amount,
sender phone, and transaction ID as a string; InstaPay `Ref` is also retained as
a string. Both parsed financial IDs are unique at the database level per
provider/source type. Unparsable retry deliveries use a delivery fingerprint.

Matching requires all of:

- pending EGP deposit using a Vodafone Cash payment method;
- exact payment transaction reference and exact decimal amount;
- compatible sender phone when the deposit contains one.

New Electronic Wallet deposits store the customer-entered `transactionId` as a
trimmed string, preserving leading zeroes, and the matcher compares that exact
field. Existing deposits can also match a legacy `paymentTransactionId` or an
explicitly labelled transaction reference in `notes`; arbitrary notes are never
searched as a reference. Without one of those references, an SMS remains
`UNMATCHED`.

`MATCHED` only links the event and deposit while `VODAFONE_SMS_AUTO_APPROVE=false`.
It does not change a deposit status, wallet balance, wallet ledger, or referral
commission. `MISMATCH` and `AMBIGUOUS` never approve. The bridge returns a 200
duplicate acknowledgement for safely repeated events.

## Future opt-in approval

If it is enabled after real-message verification, auto approval calls KA's
existing `depositService.approveDeposit` transaction; it does not have a direct
wallet-credit path. Its deposit record is labelled `reviewSource=VODAFONE_SMS_AUTO`
and carries the payment event ID. Old SMS events are not auto-approval eligible.
InstaPay has an independent opt-in flag and must remain disabled until the
receiver-side `Ref` has been proven to equal the customer-visible reference.
