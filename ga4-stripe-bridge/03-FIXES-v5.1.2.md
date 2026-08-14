# v5.1.2 — 13 August 2026, 21:35 UTC

Revision `seshdx-tracking-webhook-00052-v512`
image `sha256:f94bc05345f9964fe0169c88659c6268402a8ca78a15fd9c23795e0d7efc69e8`

Closes the two defects left open after the validation purchase.

---

## 1. Fan-out timeout — false alarm eliminated

**Symptom:** `background_dispatch_failed dispatch_timeout_15000ms` on both
13 August tests, followed seconds later by a `*_dispatched` showing all four
destinations at 200/204. An error logged for work that succeeded.

**Cause:** `Promise.race` cannot cancel whatever loses the race. The fan-out kept
running and completing, but `withTimeout` had already rejected and the caller
logged an error.

**Fix** (`src/services/tasks.js`): the bound still exists — it stops a wedged job
from pinning the request — but exceeding it is now a **slowness warning**, not a
failure. The true outcome is always logged when it arrives:

| Situation | Before | Now |
|---|---|---|
| Finishes within the bound | real value | real value, no log |
| Fails within the bound | error propagated | error propagated |
| Slow and **succeeds** | `[ERROR] dispatch_failed` | `[warn] background_dispatch_slow`, then `background_dispatch_late_success` |
| Slow and **fails** | `[ERROR] dispatch_failed` | `[warn]`, then `[ERROR] background_dispatch_failed` with the real error |

The last row is the one that matters: a genuine failure **still** becomes an
error. The warning does not hide problems, it just stops inventing them.

**The bound also moved to 90s** (`config.js` and `DESTINATION_TIMEOUT_MS`),
measured rather than guessed: the refund fan-out took 40s end to end (First
Promoter alone answers in 9–12s, then three Firestore writes). The previous
default was 3500ms.

## 2. `invoice.payment_succeeded` — an error that was not an error

**Symptom:** `[ERROR] stripe_purchase_missing_payment_intent` on every purchase.

**Cause:** Stripe removed `payment_intent` and `charge` from the top level of
Invoice in the 2025 Invoice Payments API and moved them under `payments`, a
sub-list that webhooks **do not expand by default**. On this account the invoice
arrives with none of the three.

**What is not possible:** fetching it from the Stripe API. The service holds only
the **publishable** key — there is no `STRIPE_SECRET_KEY` among the 24
environment variables. The Stripe client exists solely to verify signatures.

**Fix** (`src/handlers/stripe.js`):

- `getPaymentIntentIdFromInvoice` now covers every documented shape: direct
  field, expanded charge, `payments[].payment`, `payments[].payment_details` and
  `lines[]`. 14 tests cover each one, including the real 13 August payload.
- When there still is no payment intent, that stopped being `logError` and became
  `logInfo('stripe_purchase_deferred')` with a `handoff` field. **It is a designed
  handoff, not a failure:** `payment_intent.succeeded` arrives moments later and
  records the purchase. The code was already correctly refusing to send a purchase
  with no `transaction_id` — it was simply shouting about it.

Purchase capture behaviour is **unchanged**. What changed is that a log review no
longer shows errors on a healthy flow.

---

## Tests

```bash
cd source-code
node test/timeout.test.mjs         # 10/10
node test/payment-intent.test.mjs  # 14/14
```

## Production validation

Deployed 21:35 UTC on 13 August and validated by `/health`. **Proven with real
customer traffic at 03:07:34 UTC on 14 August** — purchase
`pi_3U4BSo7nPZQ9eEGQ0OjYyjSN`, US$145, with nobody involved:

```
03:07:27  stripe_purchase_deferred    level=info   handoff=payment_intent.succeeded
03:07:34  ga4_purchase_outbound       value=145
03:07:35  ga4_send_result             204
03:07:43  purchase_dispatched         ga4 · meta · tiktok · first_promoter   (16s)
```

- Fix 1 appears exactly as designed: `stripe_purchase_deferred` at `info` level,
  and `payment_intent.succeeded` captured the purchase 7s later.
- Fix 2 is confirmed by **absence**: no `background_dispatch_failed`, 16s of
  fan-out against a 90s bound.
- **Zero `severity>=WARNING` entries** service-wide since the deploy.
- The US$145 of revenue is in GA4's processed tables.

## Rollback

```bash
gcloud run services update-traffic seshdx-tracking-webhook \
  --region=us-central1 --project=seshdx-tracking \
  --to-revisions=seshdx-tracking-webhook-00051-sfx=100
```

`00051-sfx` is the state **proven with real traffic** (purchase and refund both
ingested). v5.1.2 changed only log semantics and a time bound — it did not touch
the delivery path — but the rollback target remains that revision.
