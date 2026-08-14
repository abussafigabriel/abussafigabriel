# Wording fix for the "SeshDx Analytics Progress Report"

Document in Drive: **SeshDx Analytics Progress Report** (23 July 2026)
https://docs.google.com/document/d/1iNrNrFg6bx4p8w6wnxp_Mtx9bmewZA7V5z4tyhPYl08/edit

**This is an internal precision fix. It does not go to the client as "we got it
wrong."** The configuration is correct and she approved it — only the sentence
describing it is imprecise. Correct it in the next revision of the document,
quietly.

---

## Where it is

Section **"What's Built and Confirmed Working"** → subsection
**"Consent and cookie banner — already solid"**.

## Current sentence (imprecise)

> Good news here: your existing cookie consent setup (Google's Consent Mode v2)
> was already correctly implemented before we started. **Tracking tools stay off
> until a visitor accepts cookies, and switch on immediately after.** Our new
> tracking code follows this exact same pattern, so nothing we add changes your
> compliance posture.

## Corrected sentence

> Good news here: your existing cookie consent setup (Google's Consent Mode v2)
> was already correctly implemented before we started. **Advertising and marketing
> tags stay off until a visitor accepts cookies. Analytics measurement runs by
> default — the configuration you approved so the Humblytics A/B tests keep
> collecting data — and the banner governs everything else.** Our new tracking
> code follows this exact same pattern, so nothing we add changes your compliance
> posture.

## Why the original is wrong

The text says **no** tool fires before consent. In practice:

| Consent signal | State before acceptance |
|---|---|
| `analytics_storage` | **`granted`** — the `_ga` cookie is written on page load |
| `ad_storage` / `ad_user_data` / `ad_personalization` | `denied` |
| `functionality_storage`, `personalization_storage` | `granted` |
| `security_storage` | `granted` |

So: **advertising** genuinely waits for consent; **measurement** does not. That
was Hillary's decision, so the Humblytics A/B tests keep working — without
`analytics_storage` granted by default, Humblytics loses its sample.

The behaviour is correct and intentional. What was wrong was the summary
generalising to "tracking tools" where it needed to distinguish advertising from
measurement.

## Risk of leaving it

Low but real: if someone on SeshDx's compliance or legal side reads the report
and then audits the site, they will find `_ga` written before consent and conclude
the report does not match the implementation. Better for the sentence to be
accurate before that question arrives from someone else.
