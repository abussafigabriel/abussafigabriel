# Evidence — validation purchase and refund, 13–14 August 2026

Every figure below was read from Cloud Logging and the GA4 Data/Realtime API,
then cross-checked against the Realtime screenshots taken at the time.

---

## 1. Controlled test — the full funnel reached GA4

Transaction **`pi_3U43tT7nPZQ9eEGQ1oRWPnaB`**, US$4.18, `livemode: true`.
Purchase at **19:02:36 UTC**. Revision `00051-sfx`.

All four events carried the **same real `client_id`** `361179969.1786647438`:

| Time UTC | Event | Send | In GA4 Realtime |
|---|---|---|---|
| 18:58:14 | `intake_start` | `204` | Present |
| 18:59:57 | `generate_lead` | `204` | Present, **key event** |
| 19:02:19 | `begin_checkout` | `204` | Present, **key event** |
| 19:02:36 | **`purchase`** | `204` | **Present, key event** |

Confirmed through the Realtime API:

```
purchase         eventCount=1   keyEvents=1
generate_lead    eventCount=1   keyEvents=1
begin_checkout   eventCount=3   keyEvents=2
intake_start     eventCount=1
```

The revenue parameter arrived with it: `value = 4.18`, event count 1 (100%). The
**Purchasers** audience gained its first user.

This was the first `pi_`-prefixed transaction ever to enter this property.

## 2. Attribution race (fix 7.1): PASSED

```
19:02:36  openloop_attribution_saved
19:02:36  ga4_purchase_outbound  clientIdPresent=true  361179969.1786647438
```

In the 15:50 attempt this read `clientIdPresent=false` with the ghost
`client_id` `2927675193.981011370`. The purchase is now bound to the same session
that completed the intake and the checkout. The widened retry window
(3×600ms → 8×1200ms) caught OpenLoop's attribution in time — the race that was
lost by 8 seconds is resolved.

## 3. Fan-out complete

```
19:02:53  purchase_dispatched  ga4:204, meta:200, tiktok:200, first_promoter:200
```

All four destinations accepted. `first_promoter_sale_outbound status=200` at
19:02:45.

---

## 4. Refund at 20:14 UTC — deduplication (fix 7.2): PASSED

Refund of US$4.18 on `ch_3U43tT7nPZQ9eEGQ1peMnjEr`, 71 minutes after the
purchase — the waiting period was deliberate.

```
20:14:03  ga4_refund_outbound   clientIdPresent=true  361179969.1786647438
20:14:03  ga4_send_result       refund  status=204    361179969.1786647438
20:14:03  meta_refund_outbound  status=200
20:14:15  first_promoter_refund_outbound  status=200
20:14:43  refund_dispatched  ga4:204, meta:200, tiktok:200, first_promoter:200
```

GA4 Realtime confirmed ingestion: `refund` eventCount=1.

### Before and after, same scenario

| | 15:52 (v5.1.0, dead secret) | 20:14 (v5.1.1 + correct secret) |
|---|---|---|
| `ga4_refund_outbound` | 2 | **1** |
| `refund_dispatched` | 2 | **1** |
| `client_id` | two, one of them a ghost | **one, the real one** |
| Ingested by GA4 | no | **yes** |

The refund's `client_id` is identical to the purchase's — revenue and reversal
land on the same user, which is what makes net revenue reconcile.

---

## 5. Unattended production purchase — 14 August 03:07 UTC

A purchase **nobody orchestrated** arrived at **03:07:34 UTC**, about five and a
half hours after the v5.1.2 deploy: `pi_3U4BSo7nPZQ9eEGQ0OjYyjSN`, **US$145**,
customer `cus_UtonccvbF5RCIM`.

```
03:07:27  stripe_purchase_deferred    level=info   handoff=payment_intent.succeeded
03:07:34  ga4_purchase_outbound       value=145
03:07:35  ga4_send_result             204
03:07:36  meta 200 · tiktok 200
03:07:37  first_promoter 204
03:07:43  purchase_dispatched         4 destinations ok          (16s total)
```

This closes the caveat left the night before, when v5.1.2 had only passed a
health check:

| Fix | Proof with real money |
|---|---|
| `invoice.payment_succeeded` | `stripe_purchase_deferred` at **info** level with the `handoff` field. The old `stripe_purchase_missing_payment_intent` at `ERROR` is gone, and the handoff worked: the invoice deferred, `payment_intent.succeeded` captured 7s later |
| Fan-out timeout | **No** `background_dispatch_failed`. 16s against a 90s bound |
| Whole service | **Zero** `severity>=WARNING` entries since the 21:35 deploy |

---

## 6. Processed tables confirm the cycle

```
13 Aug  purchase 3 · refund 1 · intake_start 5 · begin_checkout 7
        revenue 145.01   refunded 4.18

pi_3U43tT7nPZQ9eEGQ1oRWPnaB   1 purchase   revenue 0     <- our test, refunded
pi_3U4BSo7nPZQ9eEGQ0OjYyjSN   1 purchase   revenue 145   <- real customer
```

Our test reads revenue **0** because the purchase and the refund carried the same
`transaction_id` and GA4 subtracted it. This time that is genuine subtraction —
not missing data, which is what it was on 13 August before the secret was fixed.

---

## 7. Attribution — conclusion

Every transaction shows `sessionSource` and `firstUserSource` as `(not set)`,
including ours with the correct `client_id`. There are two distinct causes, and
confusing them leads to the wrong fix:

1. **Measurement Protocol limitation.** A purchase sent server-side without
   `session_id` does not join a session, so session-scoped dimensions stay empty.
   Sending `session_id` runs into the known GA4 defect that drops `purchase`
   events — which is why the worker omits it, and why we did not change it.
2. **A subscription renewal has no session to attribute.** The 03:07 purchase
   logged `attribution_not_found_for_purchase` and there was **no** OpenLoop event
   in that window. For a recurring overnight charge that is expected, not a
   defect. Purchases that go through the tracked funnel **do** pick up the real
   `client_id` — the 19:02 test proves it (`clientIdPresent=true`).

**How to position this:** GA4 is authoritative for **revenue and conversions**;
**affiliate credit lives in First Promoter**, which recorded both the sale and the
reversal in every cycle. Promising campaign attribution inside GA4 for
server-side purchases would be promising what the tool does not deliver.

---

## 8. Report latency — read before showing anyone

At the moment Realtime showed the purchase, the **processed** Data API did not:

```
Data API today - funnel events   ->  begin_checkout 3
Data API today - transactions    ->  (no rows)
```

This is **expected and not a defect**. Realtime is immediate; the processed
tables (Transactions, Reports snapshot, revenue per transaction) take hours to
24–48h. By the morning of 14 August they had all caught up, as shown in section 6.

---

## 9. Test transactions

Google Analytics cannot delete a specific transaction — the only deletion it
offers is by date range, which would take legitimate data with it. Exclude these
IDs in reports and explorations instead:

```
pi_3U43tT7nPZQ9eEGQ1oRWPnaB   4.18   13 Aug test (refunded, revenue 0)
diag-alt-1786646097511        0.01   diagnostic probe
test-verify-2026              0.01   manual test, 11 Aug
cus_V3P8ZJcdgo3qcK            2.17   old bug: customer id used as transaction
~US$1,500 in multiples of 229        test revenue predating this project
pi_3U40tr7nPZQ9eEGQ1xMtBxbP     —    NOT needed: it never reached GA4
```
