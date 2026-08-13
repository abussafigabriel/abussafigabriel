#!/usr/bin/env node
/**
 * Runs a real Stripe event through the production mapping without touching
 * the network, and prints the exact GA4 payload it would produce.
 *
 * Usage:
 *   node dry-run.mjs path/to/stripe-event.json
 *   node dry-run.mjs --sample          # uses the bundled pi_3U40tr… event
 *
 * The input may be a full Stripe event ({ "type": ..., "data": { "object": ... } })
 * or a bare object copied from the Stripe dashboard, which is wrapped for you.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildGa4Payload } = require('./function/mapping.js');

const SAMPLE = {
  type: 'payment_intent.succeeded',
  data: {
    object: {
      id: 'pi_3U40tr7nPZQ9eEGQ1xMtBxbP',
      object: 'payment_intent',
      amount: 418,
      amount_received: 418,
      currency: 'usd',
      customer: 'cus_V3nG6VxJ0y1YYp',
      description: 'Subscription creation',
      created: 1786636235,
      livemode: true,
      metadata: {},
      payment_details: { order_reference: 'in_1U40tr7nPZQ9eEGQmMaseW0h' },
      status: 'succeeded',
    },
  },
  livemode: true,
};

function loadEvent() {
  const arg = process.argv[2];
  if (!arg || arg === '--sample') return SAMPLE;

  const parsed = JSON.parse(readFileSync(arg, 'utf8'));
  if (parsed.data?.object) return parsed;

  // Bare object pasted from the dashboard: infer the event type from it.
  const inferred =
    parsed.object === 'invoice'
      ? 'invoice.paid'
      : parsed.object === 'charge'
        ? 'charge.refunded'
        : 'payment_intent.succeeded';
  console.log(`No event envelope found; assuming type "${inferred}".\n`);
  return { type: inferred, data: { object: parsed }, livemode: parsed.livemode };
}

const event = loadEvent();
const result = buildGa4Payload(event, {
  sendSessionId: process.argv.includes('--session-id'),
});

console.log(`Stripe event type : ${event.type}`);
console.log(`livemode          : ${event.livemode}`);

if (result.skip) {
  console.log(`\nRESULT: nothing would be sent to GA4 - ${result.skip}`);
} else {
  console.log(`GA4 event         : ${result.eventName}`);
  console.log(`transaction_id    : ${result.transactionId}`);
  console.log(`client_id source  : ${result.clientIdTier}`);
  console.log('\nPayload GA4 would receive:');
  console.log(JSON.stringify(result.payload, null, 2));
}

if (result.warnings.length) {
  console.log('\nWarnings:');
  for (const w of result.warnings) console.log(`  - ${w}`);
}
