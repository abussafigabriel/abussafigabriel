# SeshDx Analytics — delivery package

Everything from the tracking project, closed **14 August 2026**.
All figures were read from the Google Analytics API and the service's own logs,
never from a screenshot.

---

## Start here

| If you want to… | Open |
|---|---|
| Understand what was broken and why | `01-DIAGNOSIS.md` |
| See the proof that it works | `02-EVIDENCE.md` |
| Know what changed in the latest version | `03-FIXES-v5.1.2.md` |
| Repeat the purchase test in future | `04-RUNBOOK.md` |
| **Fix something that broke** | `05-RESTORE.md` |
| Correct one sentence in the client report | `06-REPORT-WORDING-FIX.md` |

**Client-facing page for Hillary** (private link — only she sees it if you share
it): https://claude.ai/code/artifact/ef430dee-2f50-43b6-bc80-fba64a4ba4a7

---

## The whole story in five lines

Google Analytics was receiving no purchases because its authentication secret had
been rotated on Google's side while the service kept signing with the old value.
Google answered "received" to every request and discarded all of them — which is
why the logs showed success and the reports showed zero.

Fixed 13 August. Since then: one test purchase, one refund, and **one real
customer purchase of US$145** all landed correctly, with no errors.

---

## What is in production now

```
service   seshdx-tracking-webhook   (Google Cloud Run, us-central1)
revision  seshdx-tracking-webhook-00052-v512
version   5.1.2
state     zero errors since 13 Aug 21:35 UTC
```

**If anything breaks, open `05-RESTORE.md`.** It is a single command, and the
previous known-good version is still stored intact in Google Cloud.

---

## The folders

### `source-code/`

The code running in production. **This is the only version-controlled copy** —
the freelancer never delivered the source, and this was recovered from inside the
container image. Do not lose it.

```
src/          the service
test/         24 automated tests
```

To run the tests (needs Node.js installed):

```
cd source-code
node test/timeout.test.mjs         → 10/10
node test/payment-intent.test.mjs  → 14/14
```

### `tools/`

Diagnostic scripts, for the day you distrust the tracking again:

- **`ga4-query.mjs`** — asks the Google API directly whether an event or a
  transaction arrived. This is what answers "did it land or not" without
  depending on a report.
- **`diagnose.mjs`** — tests whether Google Analytics is accepting purchases,
  without having to buy anything.
- **`dry-run.mjs`** — shows what a Stripe event turns into before it is sent.

Each file explains its usage at the top.

### `KNOWN-GOOD-SNAPSHOT.json`

A snapshot of the working configuration. The 9 sensitive values are replaced by
fingerprints — **there is no password anywhere in this package.**

---

## Three things not to forget

**1. Revoke the `claude-debug` key.** It was created for this diagnosis and needs
to be deleted. Step-by-step at the end of `05-RESTORE.md`.

**2. The test transactions remain in the history.** Google Analytics cannot delete
one specific transaction — only by date range, which would take real data with it.
The list of IDs to exclude from reports is in `04-RUNBOOK.md`.

**3. Never use `--set-env-vars` when deploying.** That is how 23 of the service's
24 settings were wiped on 11 August. Use `--update-env-vars`.
