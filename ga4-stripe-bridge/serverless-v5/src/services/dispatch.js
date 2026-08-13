import * as ga4 from './ga4.js';
import * as meta from './meta.js';
import * as tiktok from './tiktok.js';
import * as firstPromoter from './firstPromoter.js';
import {
  getAttribution,
  getAttributionWithRetry,
  markDeliveryResult,
  saveRefundMapping,
  saveTransactionMapping,
} from './firestore.js';
import { mergeAttribution, neutralSku } from '../utils/attribution.js';
import { logInfo, logWarn } from '../utils/logging.js';

function campaignParams(attr = {}) {
  return {
    ...(attr.utmSource ? { source: attr.utmSource } : {}),
    ...(attr.utmMedium ? { medium: attr.utmMedium } : {}),
    ...(attr.utmCampaign ? { campaign: attr.utmCampaign } : {}),
    ...(attr.utmContent ? { content: attr.utmContent } : {}),
    ...(attr.utmTerm ? { term: attr.utmTerm } : {}),
  };
}

async function fanOutPurchase(ctx) {
  const {
    transactionId,
    value,
    currency,
    attribution,
    idempotencyKey,
    sku,
    chargeId,
    paymentIntentId,
    stripeCustomerId,
  } = ctx;

  const ga4Result = await ga4.sendPurchase({
    clientId: attribution.gaClientId,
    sessionId: attribution.sessionId,
    transactionId,
    value,
    currency,
    items: [{ item_id: sku, item_name: sku, price: value, quantity: 1 }],
    campaign: campaignParams(attribution),
  });

  const destinations = [{ name: 'ga4', ...ga4Result }];

  if (attribution.marketingConsent !== false) {
    const [metaResult, tiktokResult, fpResult] = await Promise.all([
      meta.sendPurchase({
        eventId: transactionId,
        value,
        currency,
        fbc: attribution.fbc,
        fbclid: attribution.fbclid,
        fbp: attribution.fbp,
        externalId: attribution.sessionId || transactionId,
      }),
      tiktok.sendCompletePayment({
        eventId: transactionId,
        value,
        currency,
        ttclid: attribution.ttclid,
        externalId: attribution.sessionId || transactionId,
      }),
      firstPromoter.trackSale({
        uid: attribution.sessionId || transactionId,
        refId: attribution.refId,
        amount: value,
        currency,
        eventId: transactionId,
      }),
    ]);

    destinations.push(
      { name: 'meta', ...metaResult },
      { name: 'tiktok', ...tiktokResult },
      { name: 'first_promoter', ...fpResult },
    );
  }

  await saveTransactionMapping(paymentIntentId, {
    transactionId,
    value,
    currency,
    chargeId,
    stripeCustomerId,
    sessionId: attribution.sessionId,
    gaClientId: attribution.gaClientId,
  });

  if (chargeId) {
    await saveRefundMapping(chargeId, {
      transactionId,
      paymentIntentId,
      value,
      currency,
      stripeCustomerId,
      sessionId: attribution.sessionId,
      gaClientId: attribution.gaClientId,
    });
  }

  if (idempotencyKey) {
    await markDeliveryResult(idempotencyKey, {
      type: 'purchase',
      destinations: destinations.filter((d) => d.ok !== false).length,
    });
  }

  logInfo('purchase_dispatched', {
    transactionId,
    value,
    destinations: destinations.map((d) => ({
      name: d.name,
      ok: d.ok,
      status: d.status,
      skipped: d.skipped || false,
    })),
    reqId: ctx.reqId,
  });

  return { destinations };
}

async function fanOutRefund(ctx) {
  const {
    transactionId,
    value,
    currency,
    attribution,
    idempotencyKey,
    paymentIntentId,
    chargeId,
  } = ctx;

  const ga4Result = await ga4.sendRefund({
    clientId: attribution.gaClientId,
    sessionId: attribution.sessionId,
    transactionId,
    value,
    currency,
  });

  const destinations = [{ name: 'ga4', ...ga4Result }];

  if (attribution.marketingConsent !== false) {
    const [metaResult, tiktokResult, fpResult] = await Promise.all([
      meta.sendRefund({
        eventId: `${transactionId}_refund`,
        value,
        currency,
        fbc: attribution.fbc,
        fbclid: attribution.fbclid,
        fbp: attribution.fbp,
        externalId: attribution.sessionId || transactionId,
      }),
      tiktok.sendRefund({
        eventId: `${transactionId}_refund`,
        value,
        currency,
        ttclid: attribution.ttclid,
        externalId: attribution.sessionId || transactionId,
      }),
      firstPromoter.trackRefund({
        uid: attribution.sessionId || transactionId,
        refId: attribution.refId,
        amount: value,
        currency,
        eventId: `${transactionId}_refund`,
      }),
    ]);

    destinations.push(
      { name: 'meta', ...metaResult },
      { name: 'tiktok', ...tiktokResult },
      { name: 'first_promoter', ...fpResult },
    );
  }

  if (chargeId) {
    await saveRefundMapping(chargeId, {
      transactionId,
      paymentIntentId,
      value,
      currency,
    });
  }

  if (idempotencyKey) {
    await markDeliveryResult(idempotencyKey, {
      type: 'refund',
      destinations: destinations.filter((d) => d.ok !== false).length,
    });
  }

  logInfo('refund_dispatched', {
    transactionId,
    value,
    destinations: destinations.map((d) => ({
      name: d.name,
      ok: d.ok,
      status: d.status,
      skipped: d.skipped || false,
    })),
    reqId: ctx.reqId,
  });

  return { destinations };
}

export async function dispatchEvent(job) {
  switch (job.kind) {
    case 'stripe_purchase':
      return fanOutPurchase(job.data);
    case 'stripe_refund':
      return fanOutRefund(job.data);
    case 'openloop_funnel': {
      const ga4Result = await ga4.sendFunnelEvent(job.data);
      const { marketing } = job.data;

      if (!marketing) {
        return { ga4: ga4Result, marketing: 0 };
      }

      const calls = [
        meta.sendLead({
          eventId: marketing.eventId,
          fbc: marketing.fbc,
          fbclid: marketing.fbclid,
          fbp: marketing.fbp,
          externalId: marketing.externalId,
        }),
        tiktok.sendSubmitForm({
          eventId: marketing.eventId,
          ttclid: marketing.ttclid,
          externalId: marketing.externalId,
        }),
      ];

      if (marketing.refId && marketing.sessionId) {
        calls.push(firstPromoter.trackReferral({
          uid: marketing.sessionId,
          refId: marketing.refId,
        }));
      }

      const results = await Promise.allSettled(calls);
      return { ga4: ga4Result, marketing: results.length };
    }
    default:
      return { ignored: true };
  }
}

export async function buildPurchaseContext({
  reqId,
  idempotencyKey,
  paymentIntentId,
  chargeId,
  stripeCustomerId,
  amountPaid,
  currency,
  productHint,
}) {
  // Stripe's purchase event and OpenLoop's payment_completed fire at roughly
  // the same moment, in no guaranteed order. Without a short retry the
  // attribution is simply absent and the conversion lands with no campaign,
  // no ga_cid and no referral.
  const storedAttribution = stripeCustomerId
    ? await getAttributionWithRetry(stripeCustomerId)
    : null;

  if (!storedAttribution) {
    logWarn('attribution_not_found_for_purchase', {
      reqId,
      stripeCustomerId,
      paymentIntentId,
    });
  }

  const attribution = mergeAttribution(storedAttribution || {}, {
    sessionId: storedAttribution?.sessionId,
    gaClientId: storedAttribution?.gaClientId,
    marketingConsent: storedAttribution?.marketingConsent,
  });

  const transactionId = paymentIntentId;
  const value = amountPaid;
  const sku = neutralSku(productHint);

  return {
    reqId,
    idempotencyKey,
    transactionId,
    paymentIntentId,
    chargeId,
    stripeCustomerId,
    value,
    currency,
    sku,
    attribution,
  };
}

export async function buildRefundContext({
  reqId,
  idempotencyKey,
  paymentIntentId,
  chargeId,
  stripeCustomerId,
  amountRefunded,
  currency,
  mapping,
}) {
  const transactionId = mapping?.transactionId || paymentIntentId;
  const attribution = mergeAttribution(mapping || {}, {
    sessionId: mapping?.sessionId,
    gaClientId: mapping?.gaClientId,
    marketingConsent: mapping?.marketingConsent,
  });

  if (stripeCustomerId && !attribution.refId) {
    const stored = await getAttribution(stripeCustomerId);
    Object.assign(attribution, mergeAttribution(attribution, stored || {}));
  }

  return {
    reqId,
    idempotencyKey,
    transactionId,
    paymentIntentId,
    chargeId,
    stripeCustomerId,
    value: amountRefunded,
    currency,
    attribution,
  };
}
