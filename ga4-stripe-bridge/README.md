# SeshDx — GA4 purchase event missing: diagnosis and fix

Live purchase `pi_3U40tr7nPZQ9eEGQ1xMtBxbP` ($4.18 USD, `livemode: true`) was created
**2026-08-13 15:50:35 UTC** and produced no `purchase` event and no revenue in GA4
property `531484467`.

## What the evidence already rules out

These are dead ends — do not spend time on them.

| Hypothesis | Ruled out because |
| --- | --- |
| GA4 tag isn't installed / site isn't tracked | Realtime shows 4 active users and 22 views across `/homepage`, `/products/*`. Client-side collection works. |
| The event was too old for GA4 to accept | GA4 discards events older than 72h. This one is minutes old relative to the screenshots. |
| The refund erased the purchase | A GA4 `refund` event never deletes a `purchase` event. Purchase revenue would still read $4.18, not $0.00. |
| Reporting latency | Reports snapshot already shows today's sessions, users and traffic sources. The property is processing today's data; the purchase simply is not in it. |

The break is therefore **between Stripe and GA4**, not inside GA4's reporting.

## Ranked root causes

### 1. The Stripe webhook never fired (most likely)

Two independent reasons, either of which is fatal and both of which are silent:

- **`invoice.payment_paid` is not a Stripe event type.** The architecture diagram
  lists it as an existing webhook. Stripe's real events are **`invoice.paid`** and
  **`invoice.payment_succeeded`**. An endpoint subscribed to a name Stripe never
  emits stays quiet forever and shows zero delivery attempts.
- **Test-mode endpoint vs. a live-mode payment.** Stripe keeps test and live
  webhook endpoints completely separate, with different signing secrets. This
  charge was `livemode: true`. A webhook registered while the dashboard was in
  test mode will never see it.

Compounding both: the Stripe account belongs to **OpenLoop**, not to us. Confirm a
live-mode endpoint pointing at the Cloud Function actually exists in *their*
account.

**Check:** Stripe → Developers → Webhooks → switch to **Live mode** → open the
endpoint → look for a delivery attempt at `2026-08-13 15:50:35 UTC`.
No attempt logged = the webhook is the bug and nothing downstream matters.

### 2. No `client_id` to attribute the purchase to (confirmed structural gap)

The PaymentIntent carries `"metadata": {}` — completely empty. There is no
`ga_client_id`, no session ID, no affiliate ref. Run `node dry-run.mjs --sample`
and the mapper reports `client_id source: synthetic`.

That means even a perfectly working webhook has nothing to join the purchase back
to the browsing session. Depending on how the current function is written it will
either throw (no event at all) or emit an event attributed to `(direct)/(none)`.

The fix is upstream of the bridge: write the GA4 `client_id` (and `session_id`)
into Stripe `metadata` at checkout creation, via the intake payload the serverless
endpoint already receives.

Related symptom already visible in the screenshots: `seshdiagnostics.co…` appears
as its own **referral** source. That is a self-referral — the checkout hop is
starting a new session and discarding the original campaign attribution.

### 3. Wrong Measurement Protocol credentials or wrong property

`POST /mp/collect` answers **204 No Content for virtually any payload**, including
one with a bad `api_secret` or a measurement ID belonging to a different property.
A green log line in the Cloud Function proves delivery, never ingestion.

The API secret must be created on the **same data stream** as the measurement ID.

### 4. `session_id` on purchase events

GA4 has a long-standing defect where `purchase` events sent through the
Measurement Protocol *with* `session_id` are accepted and then never processed,
while the same event without it lands. Step 3 of the diagnostic tests both shapes
so you settle this with data instead of guessing.

### 5. `timestamp_micros` in seconds

Stripe's `created` is in **seconds** (`1786636235`). Passing it straight into
`timestamp_micros` resolves to **1970-01-01**, far outside the 72-hour window, and
GA4 drops the event silently. This bridge omits `timestamp_micros` entirely so
GA4 stamps arrival time.

## 10-minute triage

```bash
# 1. Prove whether GA4 can receive a purchase at all.
node diagnose.mjs --measurement-id G-XXXXXXX --api-secret <secret>

# 2. See what your real Stripe event maps to, without sending anything.
node dry-run.mjs --sample
node dry-run.mjs path/to/your-event.json
```

`diagnose.mjs` runs three steps:

1. **Schema validation** against `/debug/mp/collect`, which writes nothing and
   returns real error messages. (It does *not* check the API secret.)
2. **Credential proof** — a purchase with `debug_mode: 1`. Watch GA4 → Admin →
   **DebugView**. Appears within ~30s = measurement ID, API secret and property
   are all correct. Stays empty = you found the bug.
3. **`session_id` A/B** — two purchases differing only by that parameter. Whichever
   `transaction_id` shows up in Realtime tells you which shape your property accepts.

Reading the result:

- **Both land** → GA4 is healthy; the break is the Stripe webhook or the function. Go to cause 1.
- **Neither lands** → credentials or property targeting. Go to cause 3.
- **Only one lands** → set `SEND_SESSION_ID` to match and move on.

## The bridge

`function/` is a corrected Cloud Function replacing the current one. What it fixes:

- Subscribes to **`invoice.paid`** and **`charge.refunded`**, the event names Stripe actually emits.
- Verifies the Stripe signature against `req.rawBody`, not a re-serialized body.
- Rejects events whose `livemode` does not match `EXPECT_LIVEMODE`, so a test payment can never pollute production reporting.
- Converts Stripe minor units to GA4 major units (`418` → `4.18`), with the zero-decimal currency list handled.
- Uses the **invoice ID** as `transaction_id`, which is stable across Stripe retries and gives GA4 a real dedup key.
- Emits `items[]`, `currency`, `value` and `engagement_time_msec` so Purchase revenue, Transactions and Best sellers all populate.
- Omits `timestamp_micros`.
- Logs which tier the `client_id` came from, so degraded attribution is visible instead of silent.

```bash
cd function && npm install
gcloud functions deploy stripe-ga4-bridge \
  --gen2 --runtime=nodejs22 --region=us-central1 \
  --source=. --entry-point=stripeGa4Bridge \
  --trigger-http --allow-unauthenticated \
  --set-env-vars GA4_MEASUREMENT_ID=G-XXXXXXX,GA4_API_SECRET=...,STRIPE_WEBHOOK_SECRET=whsec_...
```

| Env var | Purpose |
| --- | --- |
| `GA4_MEASUREMENT_ID` | `G-XXXXXXX` from the web data stream |
| `GA4_API_SECRET` | Created on that **same** stream |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from the **live-mode** endpoint |
| `SEND_SESSION_ID` | `true` only if step 3 showed session_id events land |
| `GA4_DEBUG_MODE` | `true` routes events to DebugView while testing |
| `EXPECT_LIVEMODE` | `true` in production, `false` for a test-mode endpoint |

`lookupVisitorContext()` in `index.js` is the seam for the intake store: return
`{ ga_client_id, ga_session_id }` for a given email or Stripe customer and
attribution is restored end to end.

## Closing the attribution loop

Ordered by dependency:

1. Fix the webhook subscription (cause 1) — nothing works until an event arrives.
2. Persist `ga_client_id` + `ga_session_id` at intake, keyed by email.
3. Pass them into Stripe `metadata` at checkout, or resolve them in `lookupVisitorContext()`.
4. Re-run `diagnose.mjs` and confirm a real purchase in Transactions.
