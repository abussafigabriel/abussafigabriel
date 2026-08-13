import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { logError, logInfo } from '../utils/logging.js';

const TIKTOK_ENDPOINT = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';

function sha256(value) {
  if (!value) return undefined;
  return createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

function buildUser({ ttclid, externalId }) {
  const user = {};
  if (ttclid) user.ttclid = ttclid;
  const ext = sha256(externalId);
  if (ext) user.external_id = ext;
  return Object.keys(user).length ? user : undefined;
}

async function sendTikTok(eventName, { eventId, value, currency, ttclid, externalId, extraProps = {} }) {
  if (!config.tiktokPixelId || !config.tiktokAccessToken) {
    return { ok: false, skipped: true, reason: 'tiktok_not_configured' };
  }

  const user = buildUser({ ttclid, externalId });
  const payload = {
    event_source: 'web',
    event_source_id: config.tiktokPixelId,
    data: [{
      event: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      properties: {
        value: value ?? 0,
        currency: currency || 'USD',
        ...extraProps,
      },
      ...(user ? { user } : {}),
    }],
  };

  const response = await fetch(TIKTOK_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Access-Token': config.tiktokAccessToken,
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => ({}));
  const ok = response.ok && body?.code === 0;

  if (!ok) {
    logError('tiktok_send_failed', {
      event: eventName,
      status: response.status,
      error: JSON.stringify(body).slice(0, 200),
    });
  } else {
    logInfo('tiktok_send_result', {
      event: eventName,
      eventId,
      status: response.status,
      code: body?.code,
      value,
    });
  }

  return { ok, status: response.status, body };
}

export async function sendCompletePayment({
  eventId,
  value,
  currency = 'USD',
  ttclid,
  externalId,
}) {
  return sendTikTok('CompletePayment', {
    eventId,
    value,
    currency,
    ttclid,
    externalId,
    extraProps: { contents: [{ content_type: 'product' }] },
  });
}

export async function sendRefund({
  eventId,
  value,
  currency = 'USD',
  ttclid,
  externalId,
}) {
  return sendTikTok('Refund', {
    eventId,
    value,
    currency,
    ttclid,
    externalId,
  });
}

export async function sendSubmitForm({ eventId, ttclid, externalId }) {
  return sendTikTok('SubmitForm', {
    eventId,
    value: 0,
    currency: 'USD',
    ttclid,
    externalId,
    extraProps: { content_type: 'product' },
  });
}
