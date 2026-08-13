import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { claimIdempotency, resolveTransactionId } from '../services/firestore.js';
import { buildPurchaseContext, buildRefundContext } from '../services/dispatch.js';
import { scheduleBackground } from '../services/tasks.js';
import { centsToMajor } from '../utils/attribution.js';
import { logError, logInfo, safeErrorMessage } from '../utils/logging.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder_not_used_for_api_calls', {
  apiVersion: '2024-06-20',
});

export function verifyStripeSignature(rawBody, signatureHeader) {
  return stripe.webhooks.constructEvent(rawBody, signatureHeader, config.stripeWebhookSecret);
}

const asId = (v) => (typeof v === 'string' && v ? v : v?.id || '');

/**
 * Digs the payment intent out of every Invoice shape Stripe has shipped.
 *
 * Stripe removed the top-level `payment_intent` and `charge` fields from
 * Invoice in the 2025 Invoice Payments API and moved them under `payments`,
 * which is a sub-list that webhook payloads do NOT expand by default. On this
 * account the invoice arrives with none of the three, which is why the 13/08
 * events had no id to work with.
 *
 * There is no API fallback available: the service holds only a publishable
 * Stripe key, so `payment_intent.succeeded` is the reliable source and this
 * function is best-effort ahead of it.
 */
function getPaymentIntentIdFromInvoice(invoice) {
  const direct = asId(invoice.payment_intent);
  if (direct) return direct;

  const charge = invoice.charge;
  if (charge && typeof charge === 'object') {
    const fromCharge = asId(charge.payment_intent);
    if (fromCharge) return fromCharge;
  }

  for (const row of invoice.payments?.data || []) {
    const payment = row?.payment || row;
    const pi = asId(payment?.payment_intent ?? payment?.paymentIntent);
    if (pi) return pi;
    // Some payloads nest one level deeper under payment_details.
    const nested = asId(payment?.payment_details?.payment_intent);
    if (nested) return nested;
  }

  for (const row of invoice.lines?.data || []) {
    const pi = asId(row?.payment_intent);
    if (pi) return pi;
  }

  return '';
}

function getPaymentIntentIdFromCharge(charge) {
  if (typeof charge.payment_intent === 'string' && charge.payment_intent) {
    return charge.payment_intent;
  }
  return charge.payment_intent?.id || '';
}

function destinationCount(marketingConsent, kind = 'purchase') {
  if (marketingConsent === false) return 1;
  return kind === 'refund' ? 2 : 4;
}

function getChargeIdFromObject(obj) {
  if (typeof obj === 'string') return obj;
  return obj?.id || '';
}

async function handlePurchase({
  event,
  reqId,
  paymentIntentId,
  chargeId,
  stripeCustomerId,
  amountPaid,
  currency,
  productHint,
}) {
  const idempotencyKey = `stripe:${event.id}`;
  const piKey = paymentIntentId ? `stripe:pi:${paymentIntentId}` : null;

  const claim = await claimIdempotency(idempotencyKey, {
    source: 'stripe',
    eventType: event.type,
  });
  if (!claim.claimed) {
    return { ok: true, duplicate: true, event_type: event.type, req_id: reqId };
  }

  // Never fan-out a purchase with empty transaction_id — GA4 will drop it and
  // later refunds would have nothing to reverse.
  //
  // Reaching here is a designed handoff, not a failure: invoice.payment_succeeded
  // on this account carries no payment intent, so the purchase is picked up by
  // payment_intent.succeeded moments later. It was logged at error level, which
  // made a healthy flow look broken in every log review.
  if (!paymentIntentId) {
    logInfo('stripe_purchase_deferred', {
      reqId,
      eventType: event.type,
      chargeId,
      stripeCustomerId,
      amountPaid,
      reason: 'no_payment_intent_in_payload',
      handoff: 'payment_intent.succeeded',
    });
    return {
      ok: true,
      deferred: true,
      reason: 'missing_payment_intent',
      event_type: event.type,
      req_id: reqId,
      hint: 'Waiting for charge.succeeded or payment_intent.succeeded',
    };
  }

  if (piKey) {
    const piClaim = await claimIdempotency(piKey, {
      source: 'stripe',
      eventType: 'purchase',
      paymentIntentId,
    });
    if (!piClaim.claimed) {
      return { ok: true, duplicate: true, event_type: event.type, req_id: reqId, reason: 'payment_intent_already_processed' };
    }
  }

  const ctx = await buildPurchaseContext({
    reqId,
    idempotencyKey,
    paymentIntentId,
    chargeId,
    stripeCustomerId,
    amountPaid,
    currency,
    productHint,
  });

  scheduleBackground({
    kind: 'stripe_purchase',
    source: 'stripe',
    eventType: event.type,
    data: ctx,
  });

  logInfo('stripe_purchase_accepted', {
    reqId,
    paymentIntentId,
    transactionId: ctx.transactionId,
    value: ctx.value,
    stripeCustomerId,
    stripeEventType: event.type,
  });

  return {
    ok: true,
    event_type: event.type,
    req_id: reqId,
    transaction_id: ctx.transactionId,
    value: ctx.value,
    destinations: destinationCount(ctx.attribution?.marketingConsent, 'purchase'),
  };
}

async function handleInvoicePaymentSucceeded(event, reqId) {
  const invoice = event.data.object;
  return handlePurchase({
    event,
    reqId,
    paymentIntentId: getPaymentIntentIdFromInvoice(invoice),
    chargeId: getChargeIdFromObject(invoice.charge),
    stripeCustomerId: typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || '',
    amountPaid: centsToMajor(invoice.amount_paid ?? invoice.total ?? 0),
    currency: String(invoice.currency || 'usd').toUpperCase(),
    productHint: invoice.lines?.data?.[0]?.description || invoice.lines?.data?.[0]?.price?.nickname,
  });
}

async function handlePaymentIntentSucceeded(event, reqId) {
  const pi = event.data.object;
  return handlePurchase({
    event,
    reqId,
    paymentIntentId: pi.id,
    chargeId: typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id || '',
    stripeCustomerId: typeof pi.customer === 'string' ? pi.customer : pi.customer?.id || '',
    amountPaid: centsToMajor(pi.amount_received ?? pi.amount ?? 0),
    currency: String(pi.currency || 'usd').toUpperCase(),
    productHint: pi.metadata?.product_name || pi.metadata?.product_id,
  });
}

async function handleChargeSucceeded(event, reqId) {
  const charge = event.data.object;
  if (charge.refunded) {
    return { ok: true, ignored: true, event_type: event.type, req_id: reqId, reason: 'charge_already_refunded' };
  }
  return handlePurchase({
    event,
    reqId,
    paymentIntentId: getPaymentIntentIdFromCharge(charge),
    chargeId: charge.id,
    stripeCustomerId: typeof charge.customer === 'string' ? charge.customer : charge.customer?.id || '',
    amountPaid: centsToMajor(charge.amount_captured ?? charge.amount ?? 0),
    currency: String(charge.currency || 'usd').toUpperCase(),
    productHint: charge.description || charge.metadata?.product_name,
  });
}

/**
 * Stripe fires BOTH charge.refunded and refund.created for a single refund.
 * They carry different event ids, so keying idempotency on the event id let
 * both through and every refund was counted twice — visible in the logs as
 * two ga4_refund_outbound in the same second.
 *
 * The refund id (re_...) is present in both and is the real unit of work. It
 * also keeps partial refunds correct, which the cumulative amount_refunded
 * does not.
 */
function getRefundDetails(event) {
  const obj = event.data.object;

  if (event.type === 'refund.created') {
    return {
      refundId: obj.id || '',
      amountRefunded: centsToMajor(obj.amount ?? 0),
      currency: String(obj.currency || 'usd').toUpperCase(),
      chargeId: typeof obj.charge === 'string' ? obj.charge : obj.charge?.id || '',
      paymentIntentId: typeof obj.payment_intent === 'string'
        ? obj.payment_intent
        : obj.payment_intent?.id || '',
      stripeCustomerId: '',
    };
  }

  const charge = obj;
  const latestRefund = charge.refunds?.data?.[0];
  return {
    refundId: latestRefund?.id || '',
    amountRefunded: centsToMajor(latestRefund?.amount ?? charge.amount_refunded ?? 0),
    currency: String(charge.currency || 'usd').toUpperCase(),
    chargeId: charge.id,
    paymentIntentId: typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : charge.payment_intent?.id || '',
    stripeCustomerId: typeof charge.customer === 'string'
      ? charge.customer
      : charge.customer?.id || '',
  };
}

async function handleRefundEvent(event, reqId) {
  const {
    refundId,
    amountRefunded,
    currency,
    chargeId,
    paymentIntentId,
    stripeCustomerId,
  } = getRefundDetails(event);

  // charge + amount is the ONLY key both events agree on.
  //
  // Keying on the refund id looks more precise but fails in practice: the
  // charge.refunded payload does not always carry an expanded refunds list,
  // so it falls back to a different key than refund.created and both get
  // through. That is what happened on 2026-08-13 — one refund, two payouts
  // to every destination. Both events always carry the charge id and the
  // same amount for the same refund, so this collapses them every time.
  let idempotencyKey;
  if (chargeId) {
    idempotencyKey = `stripe:refund:${chargeId}:${Math.round(amountRefunded * 100)}`;
  } else if (refundId) {
    idempotencyKey = `stripe:refund:${refundId}`;
  } else {
    idempotencyKey = `stripe:${event.id}`;
  }

  const claim = await claimIdempotency(idempotencyKey, {
    source: 'stripe',
    eventType: event.type,
    refundId,
  });
  if (!claim.claimed) {
    return {
      ok: true,
      duplicate: true,
      event_type: event.type,
      req_id: reqId,
      reason: 'refund_already_processed',
    };
  }

  const mapping = await resolveTransactionId({ paymentIntentId, chargeId });
  if (!mapping?.transactionId && !paymentIntentId) {
    logError('stripe_refund_unlinked', {
      reqId,
      eventType: event.type,
      chargeId,
      paymentIntentId,
    });
    return {
      ok: false,
      error: 'refund_unlinked',
      event_type: event.type,
      req_id: reqId,
    };
  }

  const ctx = await buildRefundContext({
    reqId,
    idempotencyKey,
    paymentIntentId,
    chargeId,
    stripeCustomerId,
    amountRefunded,
    currency,
    mapping,
  });

  scheduleBackground({
    kind: 'stripe_refund',
    source: 'stripe',
    eventType: event.type,
    data: ctx,
  });

  logInfo('stripe_refund_accepted', {
    reqId,
    paymentIntentId,
    transactionId: ctx.transactionId,
    value: ctx.value,
    chargeId,
  });

  return {
    ok: true,
    event_type: event.type,
    req_id: reqId,
    transaction_id: ctx.transactionId,
    value: ctx.value,
    destinations: destinationCount(ctx.attribution?.marketingConsent, 'refund'),
  };
}

export async function handleStripeWebhook(rawBody, signatureHeader) {
  const reqId = randomUUID();

  if (!config.stripeWebhookSecret) {
    return { status: 500, body: { ok: false, error: 'stripe_not_configured', req_id: reqId } };
  }

  if (!signatureHeader) {
    return { status: 401, body: { ok: false, error: 'invalid_signature', req_id: reqId } };
  }

  let event;
  try {
    event = verifyStripeSignature(rawBody, signatureHeader);
  } catch (error) {
    logError('stripe_signature_invalid', { reqId, error: safeErrorMessage(error) });
    return { status: 401, body: { ok: false, error: 'invalid_signature', req_id: reqId } };
  }

  try {
    switch (event.type) {
      case 'invoice.payment_succeeded':
        return { status: 200, body: await handleInvoicePaymentSucceeded(event, reqId) };
      case 'payment_intent.succeeded':
        return { status: 200, body: await handlePaymentIntentSucceeded(event, reqId) };
      case 'charge.succeeded':
        return { status: 200, body: await handleChargeSucceeded(event, reqId) };
      case 'charge.refunded':
      case 'refund.created':
        return { status: 200, body: await handleRefundEvent(event, reqId) };
      default:
        logInfo('stripe_event_ignored', { reqId, eventType: event.type });
        return {
          status: 200,
          body: {
            ok: true,
            ignored: true,
            event_type: event.type,
            req_id: reqId,
          },
        };
    }
  } catch (error) {
    logError('stripe_handler_failed', {
      reqId,
      eventType: event.type,
      error: safeErrorMessage(error),
    });
    return { status: 500, body: { ok: false, error: 'handler_failed', req_id: reqId } };
  }
}
