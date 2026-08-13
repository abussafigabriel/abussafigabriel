import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { logError, logInfo } from '../utils/logging.js';

const GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect';

/**
 * Prefer stored ga_cid. If absent, derive a stable GA4-shaped client_id from session/PI
 * so purchase and refund share the same client (never a random timestamp).
 */
export function resolveClientId(clientId, ...seeds) {
  if (clientId) return String(clientId);
  const seed = seeds.find((s) => s);
  if (!seed) return `server.${Date.now()}`;
  const hex = createHash('sha256').update(String(seed)).digest('hex');
  const a = parseInt(hex.slice(0, 8), 16) >>> 0;
  const b = parseInt(hex.slice(8, 16), 16) >>> 0;
  return `${a}.${b}`;
}

async function sendGa4Payload(body) {
  if (!config.ga4MeasurementId || !config.ga4ApiSecret) {
    return { ok: false, skipped: true, reason: 'ga4_not_configured' };
  }

  const url = `${GA4_ENDPOINT}?measurement_id=${encodeURIComponent(config.ga4MeasurementId)}&api_secret=${encodeURIComponent(config.ga4ApiSecret)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await response.text().catch(() => '');
  const ok = response.ok;
  const eventName = body?.events?.[0]?.name;

  if (!ok) {
    logError('ga4_send_failed', {
      status: response.status,
      error: text.slice(0, 200),
      eventName,
    });
  } else {
    logInfo('ga4_send_result', {
      eventName,
      status: response.status,
      body: text.slice(0, 120),
      transactionId: body?.events?.[0]?.params?.transaction_id,
      client_id: body?.client_id,
    });
  }

  return { ok, status: response.status, body: text.slice(0, 200) };
}

function baseEvent({ clientId, eventName, params, userId }) {
  const payload = {
    client_id: clientId,
    events: [{ name: eventName, params }],
  };
  if (userId) payload.user_id = userId;
  return payload;
}

export async function sendPurchase({
  clientId,
  sessionId,
  transactionId,
  value,
  currency = 'USD',
  items = [],
  campaign = {},
}) {
  if (!transactionId) {
    logError('ga4_purchase_skipped_empty_transaction_id', { value });
    return { ok: false, skipped: true, reason: 'empty_transaction_id' };
  }

  const resolvedClientId = resolveClientId(clientId, sessionId, transactionId);
  const params = {
    transaction_id: transactionId,
    value,
    currency,
    items,
    engagement_time_msec: 1,
    ...campaign,
  };

  const payload = baseEvent({
    clientId: resolvedClientId,
    eventName: 'purchase',
    params,
  });

  logInfo('ga4_purchase_outbound', {
    transactionId,
    value,
    currency,
    clientIdPresent: Boolean(clientId),
    clientIdResolved: resolvedClientId,
  });

  return sendGa4Payload(payload);
}

export async function sendRefund({
  clientId,
  sessionId,
  transactionId,
  value,
  currency = 'USD',
}) {
  if (!transactionId) {
    logError('ga4_refund_skipped_empty_transaction_id', { value });
    return { ok: false, skipped: true, reason: 'empty_transaction_id' };
  }

  const resolvedClientId = resolveClientId(clientId, sessionId, transactionId);
  const params = {
    transaction_id: transactionId,
    value,
    currency,
    engagement_time_msec: 1,
  };

  const payload = baseEvent({
    clientId: resolvedClientId,
    eventName: 'refund',
    params,
  });

  logInfo('ga4_refund_outbound', {
    transactionId,
    value,
    currency,
    clientIdPresent: Boolean(clientId),
    clientIdResolved: resolvedClientId,
  });

  return sendGa4Payload(payload);
}

export async function sendFunnelEvent({
  clientId,
  sessionId,
  eventName,
  campaign = {},
}) {
  const resolvedClientId = resolveClientId(clientId, sessionId, eventName);
  const payload = baseEvent({
    clientId: resolvedClientId,
    eventName,
    params: {
      engagement_time_msec: 1,
      ...campaign,
    },
  });

  return sendGa4Payload(payload);
}
