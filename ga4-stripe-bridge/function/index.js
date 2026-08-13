'use strict';

/**
 * Stripe -> GA4 bridge (Google Cloud Function, gen 2).
 *
 * Deploy:
 *   gcloud functions deploy stripe-ga4-bridge \
 *     --gen2 --runtime=nodejs22 --region=us-central1 \
 *     --source=. --entry-point=stripeGa4Bridge \
 *     --trigger-http --allow-unauthenticated \
 *     --set-env-vars GA4_MEASUREMENT_ID=G-XXXXXXX,GA4_API_SECRET=...,STRIPE_WEBHOOK_SECRET=whsec_...
 *
 * Subscribe the Stripe endpoint to: invoice.paid, charge.refunded.
 * Do NOT use "invoice.payment_paid" - no such Stripe event exists, and an
 * endpoint subscribed to a non-existent type simply never fires.
 */

const functions = require('@google-cloud/functions-framework');
const Stripe = require('stripe');
const { buildGa4Payload } = require('./mapping');

const MP_ENDPOINT = 'https://www.google-analytics.com/mp/collect';

const {
  GA4_MEASUREMENT_ID,
  GA4_API_SECRET,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_SECRET_KEY,
  SEND_SESSION_ID = 'false',
  GA4_DEBUG_MODE = 'false',
  EXPECT_LIVEMODE = 'true',
} = process.env;

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : new Stripe('sk_unused');

/** Overridden in tests / extended to read the intake store keyed by email. */
async function lookupVisitorContext(/* { email, customerId } */) {
  return {};
}

async function sendToGa4(payload) {
  const url =
    `${MP_ENDPOINT}?measurement_id=${encodeURIComponent(GA4_MEASUREMENT_ID)}` +
    `&api_secret=${encodeURIComponent(GA4_API_SECRET)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  // GA4 answers 204 to essentially anything it can route, including payloads
  // it will later discard. A 2xx here is proof of delivery, never of ingestion.
  if (res.status !== 204 && res.status !== 200) {
    throw new Error(`GA4 returned HTTP ${res.status}: ${await res.text()}`);
  }
}

functions.http('stripeGa4Bridge', async (req, res) => {
  for (const [name, value] of Object.entries({
    GA4_MEASUREMENT_ID,
    GA4_API_SECRET,
    STRIPE_WEBHOOK_SECRET,
  })) {
    if (!value) {
      console.error(`Missing required env var ${name}`);
      res.status(500).send('bridge misconfigured');
      return;
    }
  }

  let event;
  try {
    // Signature verification needs the exact bytes Stripe signed; a parsed and
    // re-serialized body will not match.
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      req.headers['stripe-signature'],
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error(`Signature verification failed: ${err.message}`);
    res.status(400).send(`invalid signature: ${err.message}`);
    return;
  }

  const log = (level, msg, extra = {}) =>
    console[level](JSON.stringify({ msg, stripe_event_id: event.id, type: event.type, ...extra }));

  const expectLive = EXPECT_LIVEMODE === 'true';
  if (event.livemode !== expectLive) {
    log('warn', 'livemode mismatch, ignoring', {
      event_livemode: event.livemode,
      expected_livemode: expectLive,
    });
    res.status(200).send('ignored: livemode mismatch');
    return;
  }

  try {
    const object = event.data.object;
    const lookup = await lookupVisitorContext({
      email: object.customer_email || object.receipt_email || null,
      customerId: object.customer || null,
    });

    const result = buildGa4Payload(event, {
      lookup,
      sendSessionId: SEND_SESSION_ID === 'true',
      debugMode: GA4_DEBUG_MODE === 'true',
    });

    for (const w of result.warnings) log('warn', w);

    if (result.skip) {
      log('info', `skipped: ${result.skip}`);
      res.status(200).send(`skipped: ${result.skip}`);
      return;
    }

    await sendToGa4(result.payload);

    log('info', 'forwarded to GA4', {
      ga4_event: result.eventName,
      transaction_id: result.transactionId,
      client_id_tier: result.clientIdTier,
      value: result.payload.events[0].params.value,
      currency: result.payload.events[0].params.currency,
    });

    res.status(200).send('ok');
  } catch (err) {
    log('error', `bridge failed: ${err.message}`, { stack: err.stack });
    // 500 makes Stripe retry with backoff, which is what we want for a
    // transient GA4 or lookup failure.
    res.status(500).send('bridge error');
  }
});

module.exports = { sendToGa4, lookupVisitorContext };
