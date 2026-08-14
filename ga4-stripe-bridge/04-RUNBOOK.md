# Runbook — validating and proving SeshDx tracking in GA4

The sequence for a validation purchase, designed so **no step depends on an
earlier one having worked by luck**, and so the evidence needed for sign-off gets
captured while it still exists.

**Project rule:** a `204` from GA4 never proves delivery. Only a third-party
dashboard or the system's own logs count.

---

## PHASE 0 — Prove GA4 accepts a purchase, at no cost

**Do not skip this and do not make a real purchase before it.** If `purchase`
does not currently exist in the property's event list, there is a real chance GA4
is discarding that event specifically — and a live purchase would be another
burned test with no answer.

### 0.1 Read the secret the worker uses

```bash
gcloud run revisions describe seshdx-tracking-webhook-00052-v512 \
  --region=us-central1 --project=seshdx-tracking --format=json
```

Look for `GA4_API_SECRET` and `GA4_MEASUREMENT_ID` in the output.

### 0.2 Fire a synthetic purchase

```bash
node diagnose.mjs --measurement-id G-WHP0DJ703Q --api-secret <value>
```

### 0.3 Watch DebugView

**GA4 → Admin → DebugView**, within ~30 seconds.

Mind the device selector in the top-left corner: Measurement Protocol events
arrive as a separate device. If the screen looks empty, switch device before
concluding it failed.

| Result | Meaning | What to do |
|---|---|---|
| `purchase` appears | GA4 accepts purchases with these credentials | Go to Phase 1 |
| Nothing appears | Credential, property or filter | **Stop.** Go to "If Phase 0 fails" |

### 0.4 Confirm through the API

```bash
node ga4-query.mjs --key C:/path/claude-debug.json --days 90
```

This definitively answers whether `purchase` has ever existed in the property,
without relying on scrolling a dropdown.

---

## The `debug_mode` trap

`debug_mode` exists to **see the event in DebugView**. But if the property has an
active **Developer traffic** filter (Admin → Data Settings → Data Filters), every
debug-marked event is **excluded from reports** — it shows in DebugView and never
reaches Transactions.

That is why the Phase 2 validation purchase must go out **without** `debug_mode`.
Confirm `GA4_DEBUG_MODE` was not left enabled in Cloud Run.

Check both filter locations, because a filter in *Active* state discards data
permanently and irreversibly:

- Admin → Data Settings → **Data Filters** (property level)
- Admin → Data Streams → the stream → **more tagging settings** (internal traffic)

---

## PHASE 1 — Confirm what is live

```bash
curl -s https://seshdx-tracking-webhook-869202251383.us-central1.run.app/health
```

It must answer **5.1.2**. If it answers anything else, someone deployed over the
top — do not proceed, or you will validate a version that is not yours.

---

## PHASE 2 — The validation purchase

1. Open the site **through the affiliate link** (`?fpr=testnozgbztg`), in a
   private window. Arriving by link is what exercises attribution — without it,
   fix 7.1 is not tested.
2. Accept the consent banner.
3. Walk the funnel normally and complete the purchase with coupon `testseshdx`.
4. **Write down the exact time in UTC.**
5. **DO NOT REFUND.** Leave it untouched for at least 60 minutes.

> Skipping step 5 is exactly what invalidated the 13 August test: the refund came
> 115 seconds later carrying the same `transaction_id`, and GA4 treats that as a
> full refund and subtracts the revenue. The test erased its own evidence.

---

## PHASE 3 — Collect evidence, hop by hop

In this order, because each proves a different segment of the path:

| # | Where | What must appear | Proves |
|---|---|---|---|
| 1 | Cloud Run logs | `clientIdPresent: true` and the real `client_id` | Fix 7.1 worked |
| 2 | Cloud Run logs | `ga4_send_result status=204` | The worker called GA4 |
| 3 | GA4 → Realtime → **Event count by Event name** | `purchase` (30-minute window) | GA4 **ingested** it |
| 4 | Stripe | payment `succeeded` | Financial source of truth |
| 5 | First Promoter | commission `approved` | Affiliate attribution |
| 6 | GA4 → Transactions (24–48h later) | `transaction_id` with its value | Processed reporting |

Reading the logs:

```bash
gcloud logging read 'resource.labels.service_name="seshdx-tracking-webhook"' \
  --limit=200 --freshness=2h --project=seshdx-tracking --format=json
```

Step 3 is the most perishable: **Realtime only sees 30 minutes**. Take a
screenshot inside that window or the fastest evidence is lost.

---

## PHASE 4 — Only after 60 minutes, the refund

1. Refund through Stripe.
2. In the logs, confirm **a single** `refund_dispatched`, not two. That is what
   proves fix 7.2.
3. In First Promoter, the commission must go negative.
4. In GA4, the day's net revenue returns to zero — and that is now **correct,
   documented behaviour**, not a defect.

---

## PHASE 5 — Cleanup

**Mark** the test transactions to be ignored in analysis.

GA4 **cannot delete a specific transaction** — the only deletion available is by
date range (Admin → Data deletion requests), which would take legitimate data
with it. Exclude these IDs in reports and explorations instead:

```
pi_3U43tT7nPZQ9eEGQ1oRWPnaB   4.18   13 Aug test (refunded, revenue 0)
diag-alt-1786646097511        0.01   diagnostic probe
test-verify-2026              0.01   manual test, 11 Aug
cus_V3P8ZJcdgo3qcK            2.17   old bug: customer id used as transaction
~US$1,500 in multiples of 229        test revenue predating this project
pi_3U40tr7nPZQ9eEGQ1xMtBxbP     —    NOT needed: it never reached GA4
```

---

## If Phase 0 fails

In order, most likely cause first:

1. **A data filter** in *Active* state discarding the worker's traffic. See the
   two locations listed in the trap section above.
2. **Wrong property or stream** — the `api_secret` must have been created on the
   **same** data stream as the measurement ID. They are separate things in the UI.
3. **A rotated secret.** This is what actually happened on 13 August: the stored
   value was unchanged but GA4 no longer recognised it. Compare the secret in
   Cloud Run against GA4 → Admin → Data Streams → the stream → Measurement
   Protocol API secrets.
4. **`session_id`** — run step 3 of `diagnose.mjs`. It sends two `purchase` events
   differing only by that parameter. If only the one **without** `session_id`
   appears, that is the known GA4 defect, and the worker is already correct to
   omit it.

---

# Appendix — Proof pack for Hillary

Present it as promise → evidence. Every row is a screenshot or an API response,
never a claim.

| Promise | Evidence to show |
|---|---|
| GA4 is the single source of truth for revenue | GA4 Transactions report with the transaction ID and its value |
| Purchases are tracked end to end | `purchase` event count in Engagement → Events, plus the matching Stripe payment |
| Refunds reverse revenue correctly | `refund` event, and net revenue returning to zero for that transaction |
| Affiliate attribution works | First Promoter commission `approved`. **Not** GA4 session source — see the note below |
| Ad platforms receive the conversion | Meta CAPI `200`, TikTok `code=0`, deduplicated by `event_id` |
| No PHI reaches any analytics tool | Log field list: `action, code, dest, event, level, req_id, result, status, ts, version` |

**Two things to state plainly rather than let her discover them:**

1. **Affiliate credit lives in First Promoter, not in GA4's source report.**
   Purchases sent server-side carry no session context, so GA4 shows `(not set)`
   for session source on them. GA4 is authoritative for **revenue and
   conversions**; First Promoter is authoritative for **which affiliate earned the
   commission**. Verified 14 August: every transaction reads `(not set)`, and
   First Promoter recorded both the sale and the reversal.

2. **A fully refunded transaction correctly reads $0.00 in GA4.** GA4 subtracts a
   refund from the original purchase when both carry the same transaction ID. Zero
   revenue on a refunded test is the system working, not failing. Say this before
   showing the reports, or the first screenshot she sees will look like a failure.
