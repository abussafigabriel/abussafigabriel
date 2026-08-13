import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { logError, logInfo } from '../utils/logging.js';

const META_ENDPOINT = 'https://graph.facebook.com/v21.0';

function buildFbc(fbclid) {
  if (!fbclid) return undefined;
  return `fb.1.${Date.now()}.${fbclid}`;
}

function sha256(value) {
  if (!value) return undefined;
  return createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

/**
 * external_id is the opaque session token, hashed — never a patient
 * identifier (decision of 2026-07-30). Without it, a visitor arriving by
 * affiliate link has no fbclid and user_data goes out empty, which Meta
 * rejects with error_subcode 2804050 "insufficient customer information".
 */
function buildUserData({ fbc, fbclid, fbp, externalId }) {
  const userData = {};
  if (fbc || fbclid) userData.fbc = fbc || buildFbc(fbclid);
  if (fbp) userData.fbp = fbp;
  const ext = sha256(externalId);
  if (ext) userData.external_id = ext;

  if (Object.keys(userData).length === 0) {
    logError('meta_user_data_empty', { reason: 'no_match_key_available' });
  }
  return userData;
}

export async function sendPurchase({
  eventId,
  value,
  currency = 'USD',
  fbc,
  fbclid,
  fbp,
  externalId,
  eventSourceUrl,
}) {
  if (!config.metaPixelId || !config.metaAccessToken) {
    return { ok: false, skipped: true, reason: 'meta_not_configured' };
  }

  const payload = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: 'website',
      event_source_url: eventSourceUrl || 'https://intake.seshdiagnostics.com/',
      custom_data: {
        value,
        currency,
      },
      user_data: buildUserData({ fbc, fbclid, fbp, externalId }),
    }],
  };

  const url = `${META_ENDPOINT}/${config.metaPixelId}/events?access_token=${encodeURIComponent(config.metaAccessToken)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => ({}));
  const ok = response.ok;

  if (!ok) {
    logError('meta_send_failed', {
      status: response.status,
      error: JSON.stringify(body).slice(0, 200),
    });
  } else {
    logInfo('meta_purchase_outbound', { eventId, value, currency, status: response.status });
  }

  return { ok, status: response.status, body };
}

export async function sendLead({ eventId, fbc, fbclid, fbp, externalId }) {
  if (!config.metaPixelId || !config.metaAccessToken) {
    return { ok: false, skipped: true, reason: 'meta_not_configured' };
  }

  const payload = {
    data: [{
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: 'website',
      event_source_url: 'https://intake.seshdiagnostics.com/',
      user_data: buildUserData({ fbc, fbclid, fbp, externalId }),
      custom_data: { value: 0, currency: 'USD' },
    }],
  };

  const url = `${META_ENDPOINT}/${config.metaPixelId}/events?access_token=${encodeURIComponent(config.metaAccessToken)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    logError('meta_lead_failed', {
      status: response.status,
      error: JSON.stringify(body).slice(0, 200),
    });
  } else {
    logInfo('meta_lead_outbound', { eventId, status: response.status });
  }

  return { ok: response.ok, status: response.status };
}

export async function sendRefund({
  eventId,
  value,
  currency = 'USD',
  fbc,
  fbclid,
  fbp,
  externalId,
}) {
  if (!config.metaPixelId || !config.metaAccessToken) {
    return { ok: false, skipped: true, reason: 'meta_not_configured' };
  }

  const payload = {
    data: [{
      event_name: 'Refund',
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: 'website',
      custom_data: { value, currency },
      user_data: buildUserData({ fbc, fbclid, fbp, externalId }),
    }],
  };

  const url = `${META_ENDPOINT}/${config.metaPixelId}/events?access_token=${encodeURIComponent(config.metaAccessToken)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    logError('meta_refund_failed', {
      status: response.status,
      error: JSON.stringify(body).slice(0, 200),
    });
  } else {
    logInfo('meta_refund_outbound', { eventId, value, status: response.status });
  }

  return { ok: response.ok, status: response.status };
}
