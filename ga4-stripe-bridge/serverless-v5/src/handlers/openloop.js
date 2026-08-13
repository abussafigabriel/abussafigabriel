import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { claimIdempotency, saveAttribution } from '../services/firestore.js';
import { scheduleBackground } from '../services/tasks.js';
import { pickAttribution } from '../utils/attribution.js';
import { logError, logInfo, safeErrorMessage } from '../utils/logging.js';

// funnel_started must stay mapped to intake_start: that is the name GA4 has
// been receiving in production all along, and existing reports and
// conversions are built on it. Renaming it silently breaks them.
const OPENLOOP_EVENT_MAP = {
  funnel_started: 'intake_start',
  contact_info_submitted: 'generate_lead',
  initiate_checkout: 'begin_checkout',
};

function readEventType(body) {
  if (typeof body?.event === 'string') return body.event;
  if (typeof body?.event?.type === 'string') return body.event.type;
  if (typeof body?.type === 'string') return body.type;
  return '';
}

function readSessionId(body) {
  return body?.sessionId
    || body?.session_id
    || body?.metadata?.sessionId
    || body?.context?.sessionId
    || body?.event?.sessionId
    || '';
}

function readStripeCustomerId(body) {
  return body?.stripeCustomerId
    || body?.stripe_customer_id
    || body?.customer?.stripeCustomerId
    || body?.customer?.stripeId
    || body?.payment?.stripeCustomerId
    || body?.payment?.customerId
    || body?.metadata?.stripeCustomerId
    || body?.event?.stripeCustomerId
    || '';
}

function readAttributionFromBody(body) {
  const attr = body?.attribution || body?.tracking || body?.metadata || {};
  const consents = body?.consents || attr?.consents || body?.event?.consents || {};

  return pickAttribution({
    sessionId: readSessionId(body),
    gaClientId: attr.ga_cid || attr.gaClientId || body?.ga_cid,
    fbc: attr.fbc,
    fbclid: attr.fbclid || attr.fb_clid,
    fbp: attr.fbp,
    ttclid: attr.ttclid || body?.ttclid,
    refId: attr.fpr || attr.ref_id || attr.ref || attr.utm_term || body?.fpr,
    utmSource: attr.utm_source || attr.utmSource,
    utmMedium: attr.utm_medium || attr.utmMedium,
    utmCampaign: attr.utm_campaign || attr.utmCampaign,
    utmContent: attr.utm_content || attr.utmContent,
    utmTerm: attr.utm_term || attr.utmTerm,
    marketingConsent: consents.marketingEmail !== false,
  });
}

function sanitizeForStorage(body, attribution) {
  return {
    sessionId: attribution.sessionId || '',
    gaClientId: attribution.gaClientId || '',
    fbc: attribution.fbc || '',
    fbclid: attribution.fbclid || '',
    fbp: attribution.fbp || '',
    ttclid: attribution.ttclid || '',
    refId: attribution.refId || '',
    utmSource: attribution.utmSource || '',
    utmMedium: attribution.utmMedium || '',
    utmCampaign: attribution.utmCampaign || '',
    utmContent: attribution.utmContent || '',
    utmTerm: attribution.utmTerm || '',
    marketingConsent: attribution.marketingConsent !== false,
    openloopEventType: readEventType(body) || '',
  };
}

export function verifyOpenLoopAuth(headers) {
  const secret = headers['x-webhook-secret']
    || headers['x-openloop-token']
    || headers.authorization?.replace(/^Bearer\s+/i, '');

  if (!config.openloopSecret) return false;
  return secret === config.openloopSecret;
}

async function handlePaymentCompleted(body, reqId) {
  const stripeCustomerId = readStripeCustomerId(body);
  const attribution = readAttributionFromBody(body);

  if (!stripeCustomerId) {
    return {
      status: 422,
      body: {
        ok: false,
        error: 'missing_stripe_customer_id',
        req_id: reqId,
      },
    };
  }

  const eventKey = body?.event?.id || body?.id || reqId;
  const idempotencyKey = `openloop:payment_completed:${stripeCustomerId}:${eventKey}`;
  const claim = await claimIdempotency(idempotencyKey, {
    source: 'openloop',
    eventType: 'payment_completed',
  });

  if (!claim.claimed) {
    return {
      status: 200,
      body: {
        ok: true,
        duplicate: true,
        event_type: 'payment_completed',
        req_id: reqId,
      },
    };
  }

  await saveAttribution(stripeCustomerId, sanitizeForStorage(body, attribution));

  logInfo('openloop_attribution_saved', {
    reqId,
    stripeCustomerId,
    sessionId: attribution.sessionId,
  });

  return {
    status: 200,
    body: {
      ok: true,
      event_type: 'payment_completed',
      req_id: reqId,
      stored: 'attribution_only',
    },
  };
}

async function handleContactInfoSubmitted(body, reqId, attribution) {
  const eventKey = body?.event?.id || body?.id || reqId;
  const idempotencyKey = `openloop:contact_info_submitted:${eventKey}`;
  const claim = await claimIdempotency(idempotencyKey, {
    source: 'openloop',
    eventType: 'contact_info_submitted',
  });

  if (!claim.claimed) {
    return {
      status: 200,
      body: { ok: true, duplicate: true, event_type: 'contact_info_submitted', req_id: reqId },
    };
  }

  // A serialisable descriptor, not live Promises. Building the Promises here
  // and passing them inside the job means that if the job is ever routed
  // through Cloud Tasks, JSON.stringify turns them into {} and the Meta Lead,
  // TikTok SubmitForm and FP signup vanish without a trace.
  const marketing = attribution.marketingConsent !== false
    ? {
      eventId: `ol-${eventKey}`,
      fbc: attribution.fbc,
      fbclid: attribution.fbclid,
      fbp: attribution.fbp,
      ttclid: attribution.ttclid,
      externalId: attribution.sessionId || eventKey,
      sessionId: attribution.sessionId,
      refId: attribution.refId,
    }
    : null;

  const delivery = await scheduleBackground({
    kind: 'openloop_funnel',
    source: 'openloop',
    eventType: 'contact_info_submitted',
    data: {
      clientId: attribution.gaClientId,
      sessionId: attribution.sessionId,
      eventName: 'generate_lead',
      marketing,
      campaign: {
        ...(attribution.utmSource ? { source: attribution.utmSource } : {}),
        ...(attribution.utmMedium ? { medium: attribution.utmMedium } : {}),
        ...(attribution.utmCampaign ? { campaign: attribution.utmCampaign } : {}),
      },
    },
  });

  return {
    status: 200,
    body: {
      ok: true,
      event_type: 'contact_info_submitted',
      req_id: reqId,
      delivered: delivery.ok,
      destinations: attribution.marketingConsent !== false ? 3 : 1,
    },
  };
}

async function handleFunnelEvent(eventType, body, reqId) {
  const gaEventName = OPENLOOP_EVENT_MAP[eventType];
  if (!gaEventName) {
    return {
      status: 200,
      body: { ok: true, ignored: true, event_type: eventType, req_id: reqId },
    };
  }

  const attribution = readAttributionFromBody(body);
  const eventKey = body?.event?.id || body?.id || reqId;
  const idempotencyKey = `openloop:${eventType}:${eventKey}`;
  const claim = await claimIdempotency(idempotencyKey, {
    source: 'openloop',
    eventType,
  });

  if (!claim.claimed) {
    return {
      status: 200,
      body: { ok: true, duplicate: true, event_type: eventType, req_id: reqId },
    };
  }

  const delivery = await scheduleBackground({
    kind: 'openloop_funnel',
    source: 'openloop',
    eventType,
    data: {
      clientId: attribution.gaClientId,
      sessionId: attribution.sessionId,
      eventName: gaEventName,
      campaign: {
        ...(attribution.utmSource ? { source: attribution.utmSource } : {}),
        ...(attribution.utmMedium ? { medium: attribution.utmMedium } : {}),
        ...(attribution.utmCampaign ? { campaign: attribution.utmCampaign } : {}),
      },
    },
  });

  return {
    status: 200,
    body: {
      ok: true,
      event_type: eventType,
      req_id: reqId,
      delivered: delivery.ok,
      destinations: 1,
    },
  };
}

export async function handleOpenLoopWebhook(body, headers) {
  const reqId = randomUUID();

  if (!verifyOpenLoopAuth(headers)) {
    return { status: 401, body: { ok: false, error: 'unauthorized', req_id: reqId } };
  }

  const eventType = readEventType(body);
  if (!eventType) {
    return { status: 422, body: { ok: false, error: 'missing_event_type', req_id: reqId } };
  }

  try {
    switch (eventType) {
      case 'payment_completed':
        return handlePaymentCompleted(body, reqId);
      case 'contact_info_submitted':
        return handleContactInfoSubmitted(body, reqId, readAttributionFromBody(body));
      case 'funnel_started':
      case 'initiate_checkout':
        return handleFunnelEvent(eventType, body, reqId);
      default:
        logInfo('openloop_event_ignored', { reqId, eventType });
        return {
          status: 200,
          body: { ok: true, ignored: true, event_type: eventType, req_id: reqId },
        };
    }
  } catch (error) {
    logError('openloop_handler_failed', {
      reqId,
      eventType,
      error: safeErrorMessage(error),
    });
    return { status: 500, body: { ok: false, error: 'handler_failed', req_id: reqId } };
  }
}
