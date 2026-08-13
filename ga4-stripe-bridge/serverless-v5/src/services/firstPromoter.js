import { config } from '../config.js';
import { logError, logInfo } from '../utils/logging.js';

const FP_BASE = 'https://firstpromoter.com/api/v1';

function fpHeaders() {
  // Empirically: this account accepts Bearer auth (204) and rejects X-API-KEY (401).
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: `Bearer ${config.firstPromoterApiKey}`,
  };
  if (config.firstPromoterAccountId) {
    headers['Account-ID'] = config.firstPromoterAccountId;
  }
  return headers;
}

async function fpRequest(path, params) {
  if (!config.firstPromoterApiKey) {
    return { ok: false, skipped: true, reason: 'first_promoter_not_configured' };
  }

  const response = await fetch(`${FP_BASE}${path}`, {
    method: 'POST',
    headers: fpHeaders(),
    body: new URLSearchParams(params).toString(),
  });

  const text = await response.text().catch(() => '');
  return { ok: response.ok, status: response.status, body: text.slice(0, 200) };
}

export async function trackSale({ uid, refId, amount, currency = 'USD', eventId }) {
  if (!uid) {
    return { ok: false, skipped: true, reason: 'missing_uid' };
  }

  const params = {
    uid: String(uid),
    event_id: eventId,
    amount: String(Math.round(Number(amount) * 100)),
    currency,
    ...(refId ? { ref_id: String(refId) } : {}),
  };

  const result = await fpRequest('/track/sale', params);
  if (result.ok) {
    logInfo('first_promoter_sale_outbound', {
      uid,
      refId,
      amount,
      eventId,
      status: result.status,
    });
  } else if (!result.skipped) {
    logError('first_promoter_sale_failed', {
      status: result.status,
      error: result.body,
      hasAccountId: Boolean(config.firstPromoterAccountId),
    });
  }
  return result;
}

export async function trackRefund({ uid, refId, amount, currency = 'USD', eventId }) {
  if (!uid) {
    return { ok: false, skipped: true, reason: 'missing_uid' };
  }

  const params = {
    uid: String(uid),
    event_id: eventId,
    amount: String(Math.round(Number(amount) * 100)),
    currency,
    ...(refId ? { ref_id: String(refId) } : {}),
  };

  const result = await fpRequest('/track/refund', params);
  if (result.ok) {
    logInfo('first_promoter_refund_outbound', {
      uid,
      refId,
      amount,
      eventId,
      status: result.status,
    });
  } else if (!result.skipped) {
    logError('first_promoter_refund_failed', {
      status: result.status,
      error: result.body,
      hasAccountId: Boolean(config.firstPromoterAccountId),
    });
  }
  return result;
}

export async function trackReferral({ uid, refId }) {
  if (!uid || !refId) {
    return { ok: false, skipped: true, reason: 'missing_uid_or_ref' };
  }
  const result = await fpRequest('/track/signup', {
    uid: String(uid),
    ref_id: String(refId),
  });
  if (result.ok) {
    logInfo('first_promoter_signup_outbound', { uid, refId, status: result.status });
  }
  return result;
}
