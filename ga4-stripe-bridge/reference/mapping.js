'use strict';

/**
 * Stripe -> GA4 Measurement Protocol mapping.
 *
 * Kept free of I/O so the same code that runs in production can be exercised
 * by the dry-run tool against a real Stripe event.
 */

// Currencies Stripe quotes in whole units; every other currency is in minor
// units and must be divided by 100 before it becomes a GA4 `value`.
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
  'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

function toMajorUnits(amount, currency) {
  const code = String(currency || 'usd').toUpperCase();
  const divisor = ZERO_DECIMAL.has(code) ? 1 : 100;
  return Math.round((amount / divisor) * 100) / 100;
}

/**
 * GA4 rejects events whose client_id it cannot parse, and a client_id that
 * never belonged to a real browser session starts a brand new user with no
 * acquisition data. Resolution order matters: the further down we fall, the
 * more attribution is lost, so callers should log which tier was used.
 */
function resolveClientId(sources) {
  const { metadata = {}, lookup = {}, fallbackSeed } = sources;

  const candidates = [
    ['metadata.ga_client_id', metadata.ga_client_id],
    ['metadata.client_id', metadata.client_id],
    ['lookup.ga_client_id', lookup.ga_client_id],
  ];

  for (const [tier, raw] of candidates) {
    if (!raw) continue;
    const m = String(raw).match(/^GA\d\.\d\.(.+)$/);
    return { clientId: m ? m[1] : String(raw), tier, attributed: true };
  }

  if (!fallbackSeed) return { clientId: null, tier: 'none', attributed: false };

  // Deterministic so a retry of the same Stripe event does not mint a second
  // user. Revenue lands, acquisition does not - this is a degraded mode.
  let hash = 0;
  const seed = String(fallbackSeed);
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return {
    clientId: `${hash}.${Math.floor(Date.now() / 1000)}`,
    tier: 'synthetic',
    attributed: false,
  };
}

function itemsFromInvoice(invoice, fallbackValue, currency) {
  const lines = invoice?.lines?.data;
  if (!Array.isArray(lines) || lines.length === 0) {
    return [{
      item_id: invoice?.id || 'unknown',
      item_name: invoice?.description || 'Subscription',
      price: fallbackValue,
      quantity: 1,
    }];
  }
  return lines.map((line) => ({
    item_id: line.price?.id || line.plan?.id || line.id,
    item_name: line.description || line.price?.nickname || line.plan?.nickname || 'Subscription',
    price: toMajorUnits(line.amount ?? 0, line.currency || currency),
    quantity: line.quantity ?? 1,
  }));
}

/**
 * Builds the GA4 payload for a Stripe event, or explains why it cannot.
 *
 * @returns {{skip?: string, warnings: string[], eventName?: string,
 *            transactionId?: string, clientIdTier?: string, payload?: object}}
 */
function buildGa4Payload(stripeEvent, options = {}) {
  const { lookup = {}, sendSessionId = false, debugMode = false } = options;
  const warnings = [];
  const type = stripeEvent?.type;
  const object = stripeEvent?.data?.object;

  if (!object) return { skip: 'event has no data.object', warnings };

  let eventName;
  let amount;
  let currency;
  let transactionId;
  let invoice = null;
  let metadata = object.metadata || {};

  switch (type) {
    // `invoice.payment_paid` is NOT a Stripe event type. The real ones are
    // `invoice.paid` and `invoice.payment_succeeded`.
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      eventName = 'purchase';
      invoice = object;
      amount = object.amount_paid;
      currency = object.currency;
      // The invoice ID is stable across retries of the same billing period,
      // which is exactly what GA4 needs to dedupe a purchase.
      transactionId = object.id;
      metadata = { ...(object.subscription_details?.metadata || {}), ...metadata };
      break;

    case 'payment_intent.succeeded':
      eventName = 'purchase';
      amount = object.amount_received ?? object.amount;
      currency = object.currency;
      transactionId = object.payment_details?.order_reference || object.id;
      break;

    case 'charge.refunded':
      eventName = 'refund';
      amount = object.amount_refunded;
      currency = object.currency;
      transactionId = object.invoice || object.payment_intent || object.id;
      break;

    default:
      return { skip: `unhandled event type "${type}"`, warnings };
  }

  if (!amount || amount <= 0) {
    return { skip: `amount is ${amount}, nothing to report`, warnings };
  }

  const value = toMajorUnits(amount, currency);

  const { clientId, tier, attributed } = resolveClientId({
    metadata,
    lookup,
    fallbackSeed: object.customer || transactionId,
  });

  if (!clientId) {
    return { skip: 'no client_id could be resolved and no fallback seed', warnings };
  }
  if (!attributed) {
    warnings.push(
      `client_id resolved via "${tier}" - revenue will land in GA4 but the ` +
        'purchase will be attributed to (direct)/(none), not the original campaign. ' +
        'Fix by writing the GA4 client_id into Stripe metadata at checkout.'
    );
  }

  const params = {
    transaction_id: transactionId,
    value,
    currency: String(currency).toUpperCase(),
    engagement_time_msec: 100,
    items: invoice
      ? itemsFromInvoice(invoice, value, currency)
      : [{ item_id: transactionId, item_name: 'Subscription', price: value, quantity: 1 }],
  };

  if (sendSessionId) {
    const sessionId = metadata.ga_session_id || lookup.ga_session_id;
    if (sessionId) {
      params.session_id = String(sessionId);
    } else {
      warnings.push('SEND_SESSION_ID is on but no ga_session_id was available.');
    }
  }
  if (debugMode) params.debug_mode = 1;

  return {
    warnings,
    eventName,
    transactionId,
    clientIdTier: tier,
    // timestamp_micros is intentionally absent. Stripe's `created` is in
    // SECONDS; passing it straight through as micros resolves to 1970 and GA4
    // silently discards anything older than 72 hours.
    payload: { client_id: clientId, events: [{ name: eventName, params }] },
  };
}

module.exports = { buildGa4Payload, toMajorUnits, resolveClientId };
