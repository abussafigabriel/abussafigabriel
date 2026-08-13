/**
 * In-memory Firestore for local testing (FIRESTORE_MOCK=1).
 * Production uses @google-cloud/firestore.
 */
import { Firestore } from '@google-cloud/firestore';
import { config } from '../config.js';
import { logError } from '../utils/logging.js';

const USE_MOCK = () => process.env.FIRESTORE_MOCK === '1';

const memory = {
  idempotency: new Map(),
  attribution: new Map(),
  transactions: new Map(),
  refunds: new Map(),
};

let firestoreSingleton;

const db = () => {
  if (USE_MOCK()) return null;
  if (!firestoreSingleton) {
    firestoreSingleton = new Firestore({
      projectId: config.projectId,
      ignoreUndefinedProperties: true,
    });
  }
  return firestoreSingleton;
};

/** Firestore rejects undefined field values — strip them before every write. */
function stripUndefined(obj = {}) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export async function claimIdempotency(key, metadata = {}) {
  if (USE_MOCK()) {
    if (memory.idempotency.has(key)) {
      return { claimed: false, doc: memory.idempotency.get(key) };
    }
    const doc = { createdAt: new Date().toISOString(), ...metadata };
    memory.idempotency.set(key, doc);
    return { claimed: true };
  }

  const firestore = db();
  const ref = firestore.collection('webhook_idempotency').doc(key);
  const leaseMs = config.idempotencyLeaseSeconds * 1000;

  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);

    if (snap.exists) {
      const data = snap.data();

      // Already delivered — a genuine duplicate.
      if (data?.delivery) {
        return { claimed: false, doc: data };
      }

      // Claimed but never delivered. While the lease holds, another request
      // is mid-flight, so keep deduping. Once it expires, the earlier attempt
      // died before fan-out and the retry has to be allowed through —
      // otherwise the conversion is lost permanently.
      const claimedAt = Date.parse(data?.createdAt || '');
      if (Number.isFinite(claimedAt) && Date.now() - claimedAt < leaseMs) {
        return { claimed: false, doc: data, inFlight: true };
      }

      tx.set(ref, stripUndefined({ createdAt: new Date().toISOString(), ...metadata }), { merge: true });
      return { claimed: true, reclaimed: true };
    }

    tx.set(ref, stripUndefined({ createdAt: new Date().toISOString(), ...metadata }));
    return { claimed: true };
  });
}

export async function saveAttribution(stripeCustomerId, payload) {
  if (!stripeCustomerId) return;
  const data = stripUndefined({ ...payload, updatedAt: new Date().toISOString() });
  if (USE_MOCK()) {
    memory.attribution.set(stripeCustomerId, { ...memory.attribution.get(stripeCustomerId), ...data });
    return;
  }
  await db().collection('attribution_by_customer').doc(stripeCustomerId).set(data, { merge: true });
}

export async function getAttribution(stripeCustomerId) {
  if (!stripeCustomerId) return null;
  if (USE_MOCK()) return memory.attribution.get(stripeCustomerId) || null;
  const snap = await db().collection('attribution_by_customer').doc(stripeCustomerId).get();
  return snap.exists ? snap.data() : null;
}

/**
 * The Stripe purchase event and OpenLoop's payment_completed race each other
 * and their order is not guaranteed. A few short re-reads cost about a second
 * and are the difference between a conversion carrying full attribution and
 * one carrying none.
 */
export async function getAttributionWithRetry(stripeCustomerId, options = {}) {
  // Measured on 2026-08-13: Stripe's payment_intent.succeeded landed at
  // 15:50:43 and OpenLoop's payment_completed at 15:50:51 — 8 seconds later.
  // A 1.2s window lost the race and the purchase went to GA4 with a derived
  // client_id instead of the real ga_cid, which is precisely the attribution
  // loss this whole layer exists to prevent. Wait long enough to win it.
  // 8 x 1.2s = ~9.6s worst case, and only when attribution never arrives at
  // all — the common path returns on the first read. Kept short enough that
  // retry + fan-out still fits inside Stripe's webhook timeout.
  const { attempts = 8, delayMs = 1200 } = options;
  if (!stripeCustomerId) return null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const found = await getAttribution(stripeCustomerId);
    if (found) return found;
    if (attempt < attempts - 1) {
      await new Promise((resolve) => { setTimeout(resolve, delayMs); });
    }
  }
  return null;
}

export async function saveTransactionMapping(paymentIntentId, payload) {
  if (!paymentIntentId) return;
  const data = stripUndefined({ ...payload, updatedAt: new Date().toISOString() });
  if (USE_MOCK()) {
    memory.transactions.set(paymentIntentId, { ...memory.transactions.get(paymentIntentId), ...data });
    return;
  }
  await db().collection('transactions_by_payment_intent').doc(paymentIntentId).set(data, { merge: true });
}

export async function getTransactionMapping(paymentIntentId) {
  if (!paymentIntentId) return null;
  if (USE_MOCK()) return memory.transactions.get(paymentIntentId) || null;
  const snap = await db().collection('transactions_by_payment_intent').doc(paymentIntentId).get();
  return snap.exists ? snap.data() : null;
}

export async function saveRefundMapping(chargeId, payload) {
  if (!chargeId) return;
  const data = stripUndefined({ ...payload, updatedAt: new Date().toISOString() });
  if (USE_MOCK()) {
    memory.refunds.set(chargeId, { ...memory.refunds.get(chargeId), ...data });
    return;
  }
  await db().collection('refunds_by_charge').doc(chargeId).set(data, { merge: true });
}

export async function getRefundMappingByCharge(chargeId) {
  if (!chargeId) return null;
  if (USE_MOCK()) return memory.refunds.get(chargeId) || null;
  const snap = await db().collection('refunds_by_charge').doc(chargeId).get();
  return snap.exists ? snap.data() : null;
}

export async function resolveTransactionId({ paymentIntentId, chargeId }) {
  if (paymentIntentId) {
    const byIntent = await getTransactionMapping(paymentIntentId);
    if (byIntent?.transactionId) return byIntent;
  }
  if (chargeId) {
    const byCharge = await getRefundMappingByCharge(chargeId);
    if (byCharge?.transactionId) return byCharge;
  }
  return null;
}

export async function markDeliveryResult(idempotencyKey, result) {
  try {
    if (USE_MOCK()) {
      const existing = memory.idempotency.get(idempotencyKey) || {};
      memory.idempotency.set(idempotencyKey, {
        ...existing,
        delivery: result,
        deliveredAt: new Date().toISOString(),
      });
      return;
    }
    await db().collection('webhook_idempotency').doc(idempotencyKey).set({
      delivery: result,
      deliveredAt: new Date().toISOString(),
    }, { merge: true });
  } catch (error) {
    logError('firestore_delivery_update_failed', { idempotencyKey, error: error.message });
  }
}

/** Test helper — reset in-memory store between tests */
export function resetMockStore() {
  memory.idempotency.clear();
  memory.attribution.clear();
  memory.transactions.clear();
  memory.refunds.clear();
}

export function getMockStore() {
  return memory;
}
