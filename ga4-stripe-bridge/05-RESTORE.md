# Restoring the known-good state

**State validated 13 August 2026, 20:14 UTC.** Purchase and refund both
demonstrably ingested by GA4, with correct attribution and no duplication.

```
revision  seshdx-tracking-webhook-00051-sfx
image     ...seshdx-tracking-webhook@sha256:23fc981dc453ce07c6075cd9fafbfc6b33035b4bdda21e5cd5f8bf5a10bb6089
env       24 variables  |  GA4_API_SECRET sha 0d3a6bf767  |  G-WHP0DJ703Q
```

## If something breaks — one command

```bash
gcloud run services update-traffic seshdx-tracking-webhook \
  --region=us-central1 --project=seshdx-tracking \
  --to-revisions=seshdx-tracking-webhook-00051-sfx=100
```

Cloud Run revisions are **immutable**: `00051-sfx` still exists with the correct
secrets inside it, whatever happens to newer revisions. That is why this file
needs to store no secret at all — and does not.

`KNOWN-GOOD-SNAPSHOT.json` holds the full configuration, with the 9 sensitive
values replaced by SHA-256 fingerprints so a restore can still be verified.

## Confirming the restore worked

```bash
curl -s https://seshdx-tracking-webhook-869202251383.us-central1.run.app/health
```

Expected: `"version":"5.1.2"` and `"ga4":true` — or `"5.1.1"` if you rolled back
to `00051-sfx`.

## Relevant revision history

| Revision | State |
|---|---|
| `00052-v512` | **CURRENT** — v5.1.2. Log and timeout fixes; delivery path untouched |
| `00051-sfx` | **ROLLBACK TARGET** — v5.1.1 + correct secret. Proven with real traffic |
| `00050-vid` | Broken: v5.1.1 with the dead secret — GA4 answered 204 and discarded |
| `00048-vut` | Broken: v5.1.0, dead secret, without fixes 7.1/7.2 |
| `00027-tnm` | Broken: 1 env var, no measurement ID |

**Never use `--set-env-vars`** — it replaces the entire set. That is how 23 of the
24 variables were wiped on 11 August. Use `--update-env-vars`.

---

# Revoke the `claude-debug` key — do this when the project closes

The service account `claude-debug@seshdx-tracking.iam.gserviceaccount.com` was
created for this diagnosis and holds high privileges (Cloud Run Admin, Datastore
Owner). Its key circulated in conversation. **It needs to be deleted.**

This is not urgent enough to break anything: deleting the key does not affect
production, which runs under a different identity
(`869202251383-compute@developer.gserviceaccount.com`).

## Through the console, no commands

1. Open **https://console.cloud.google.com/iam-admin/serviceaccounts?project=seshdx-tracking**
2. Click **claude-debug@seshdx-tracking.iam.gserviceaccount.com**
3. **KEYS** tab → find key id `0fb61f39ce239dcda3b220ffd2b52d3f7f7bf441`
   → trash icon → **Delete**
4. Optional and safer still: go back to the list and **delete the whole service
   account**, since nothing in production uses it.

## Also worth deleting

- The key file in `_INTERNO_NAO_COMPARTILHAR/` on your machine.
- That account's GA4 access: **GA4 → Admin → Property access management** →
  remove `claude-debug@seshdx-tracking.iam.gserviceaccount.com`.

## Confirming it worked

After deleting, any script in this package that uses the key should fail with an
invalid-credential error. If it fails, it is revoked.
