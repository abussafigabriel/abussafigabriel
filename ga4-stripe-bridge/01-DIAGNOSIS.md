# SeshDx — GA4 diagnosis, backed by API evidence

Investigation closed 13–14 August 2026 by querying the **GA4 Data API**, the
**Cloud Run Admin API** and **Cloud Logging** with the `claude-debug` service
account. Nothing here comes from a report screenshot.

---

## The answer

**No Measurement Protocol event reached GA4 on 13 August.** It was not the
`purchase` event, not the `client_id`, and not a refund subtracting revenue.

The worker sent **7 events** between 15:46 and 15:52, all answered `204`:

| Time UTC | Event | client_id used | In GA4? |
|---|---|---|---|
| 15:46:36 | `intake_start` | `1234833447.1786635973` (real) | **No** |
| 15:46:47 | `intake_start` | `1234833447.1786635973` (real) | **No** |
| 15:49:04 | `generate_lead` | `1234833447.1786635973` (real) | **No** |
| 15:49:42 | `begin_checkout` | `1234833447.1786635973` (real) | **No** |
| 15:50:43 | `purchase` | `2927675193.981011370` (ghost) | **No** |
| 15:52:38 | `refund` | `2927675193.981011370` (ghost) | **No** |
| 15:52:38 | `refund` | `1234833447.1786635973` (real) | **No** |

Everything GA4 did record on 13 August was browser-side: `page_view` 100,
`session_start` 46, `first_visit` 28, `scroll` 23, `quiz_start` 20,
`view_item_list` 13, `begin_checkout` 3, `view_item` 3, `form_start` 2, `click` 1.

Because events carrying the **correct** `client_id` disappeared too, the failure
was the whole channel, not one event type.

---

## Ruled out, with evidence

| Hypothesis | Ruled out because |
|---|---|
| `purchase` does not exist in this property | It does: purchases on 18/05, 20/05, 26/05, 03/06, 15/06, 17/06, 23/06, 26/06, 29/06, 06/07, 12/07, 23/07, 31/07, 02/08, 03/08, 06/08 and **11/08** |
| A data filter was discarding traffic | The *Internal Traffic* filter is in **Testing** state, not Active. `testDataFilterName` returns `(not set)` across all 38,512 events — it matches nothing |
| The credential changed in Cloud Run | `GA4_MEASUREMENT_ID=G-WHP0DJ703Q` and `GA4_API_SECRET` (sha `c06192d262`) are **identical** in the live revision and in the 11 August revisions that were delivering |
| Report latency | Browser events from 13 August were already in the API. The worker's events, from the same window, were not |
| The `session_id` defect | Events without `session_id` and with the real `client_id` vanished as well |

---

## The configuration gap that explains 12 August

The Cloud Run revisions show a window where the service ran **without the
measurement ID**:

| Revision | Created | MEASUREMENT_ID | env vars |
|---|---|---|---|
| `00034-cuz` | 11 Aug 02:59 | `G-WHP0DJ703Q` | 24 |
| `00027-tnm` | **11 Aug 18:30** | **missing** | **1** |
| `00028-tgq` | 11 Aug 18:30 | **missing** | **1** |
| `00029-fz4` | 13 Aug 12:26 | **missing** | 9 |
| `00030-qxj` | 13 Aug 12:26 | `G-WHP0DJ703Q` | 16 |
| `00050-vid` | 13 Aug 16:06 | `G-WHP0DJ703Q` | 24 |

From **11 Aug 18:30 until 13 Aug 12:26** the service ran with **one environment
variable** and no measurement ID. That fully explains why the 12 August test
purchase — which First Promoter did record — never appeared in GA4.

This is exactly the accident the handoff warns about: `--set-env-vars` replaces
the entire set. Someone deployed with that flag and wiped 23 of the 24 variables.

**But by 13 Aug 15:50 the configuration was correct again**, so this gap explains
12 August and **not** 13 August.

---

## Root cause, confirmed by A/B test

Two identical probes run **from inside GCP** (a throwaway Cloud Run job using the
worker's own image), differing only in the `api_secret`, verified through the
Realtime API:

| Secret | Send result | Outcome in GA4 |
|---|---|---|
| `sha c06192d262` (live revision 00050-vid) | `204` | **Never ingested** (14 polls, 4.5 min) |
| `sha 0d3a6bf767` (11 August ghost revisions) | `204` | **Ingested on the first poll** (~30 s) |

**Root cause:** the Measurement Protocol secret was rotated in GA4 on the night of
11 August — the same aborted operation that destroyed the environment variables.
The 13 August restore used a snapshot from **before** the rotation, so the worker
was signing with a secret GA4 had already deleted. Every send received `204` and
was discarded.

`204` never proved anything. It is the acknowledgement that a request was
routable, not that its contents were accepted.

---

## Fix applied

```
00051-sfx  created at 0% traffic, tag rc-v512  →  /health 200 v5.1.1  →  100% traffic
GA4_API_SECRET: c06192d262 → 0d3a6bf767   (only change; all 24 env vars preserved)
```

Later superseded by `00052-v512` (version 5.1.2) — see `03-FIXES-v5.1.2.md`.

---

## Two defects confirmed during the test purchase

Both appeared in the 15:50–15:52 logs. They confirm the v5.1.1 fixes were
necessary — and that they had **not** been exercised, because v5.1.1 only went
live at 16:06, after the test.

**Refund counted twice, with a different `client_id` on each:**

```
15:52:38  ga4_refund_outbound  clientIdPresent=false  2927675193.981011370
15:52:38  ga4_refund_outbound  clientIdPresent=true   1234833447.1786635973
15:52:47  refund_dispatched   (4 destinations)
15:52:49  refund_dispatched   (4 destinations)
```

Had the channel been working, this would have recorded **one more refund than
purchase**, against a user who never bought — orphan negative revenue.

**Delivery timeout:**

```
15:52:41  background_dispatch_failed  dispatch_timeout_2500ms  refund.created
15:52:42  background_dispatch_failed  dispatch_timeout_2500ms  charge.refunded
```

---

## A detail worth noting

No transaction with a `pi_` prefix had ever entered GA4 before this project. The
historical `transaction_id` values are:

```
ch_3TePnpAWBcytp9Oj30VO3fKD    506.96
ch_3U1bWmAWBcytp9Oj2Z9nLfgS   1495.00
py_3TbSUhAWBcytp9Oj3Y7zgnhh    476.76
cus_V3P8ZJcdgo3qcK               2.17   <- a CUSTOMER id used as a transaction
test-verify-2026                 0.01   <- manual test from 11 August
```

The current architecture uses `transaction_id = payment_intent` (`pi_`). The
history uses `ch_`, `py_` and — on 11 August — even a `cus_`. Reports will mix
two identifier schemes, and the older ~US$1,500 of test revenue is still there.

---

# Final state — 14 August 2026

| Deliverable | Status |
|---|---|
| GA4 as source of truth (`purchase` + `refund` ingested) | Proven via API |
| Attribution bound to the real session | Same `client_id` on both events |
| Refund deduplication | 1 dispatch, was 2 |
| Meta CAPI / TikTok / First Promoter | 200 on both cycles |
| Fan-out timeout | Fixed in v5.1.2, proven in production |
| `invoice.payment_succeeded` | Fixed in v5.1.2, proven in production |
| Affiliate attribution | In First Promoter — GA4 limitation documented |
| Errors in production | Zero since 13 Aug 21:35 |

**In production:** revision `00052-v512`, version 5.1.2, `/health` 200 with all
dependencies green and no errors in the logs.

**Proven with real money:** customer purchase `pi_3U4BSo7nPZQ9eEGQ0OjYyjSN`
(US$145) arrived unattended at 03:07 UTC on 14 August and traversed the entire
pipeline in 16 seconds without a single error.
