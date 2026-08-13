const VERSION = '5.1.2';

function env(name, aliases = []) {
  const keys = [name, ...aliases];
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return '';
}

export const config = {
  version: VERSION,
  port: Number(process.env.PORT || 8080),
  projectId: env('GCP_PROJECT', ['GCP_PROJECT_ID', 'GOOGLE_CLOUD_PROJECT']) || 'seshdx-tracking',
  openloopSecret: env('OPENLOOP_SHARED_SECRET', ['OPENLOOP_WEBHOOK_TOKEN']),
  stripeWebhookSecret: env('STRIPE_WEBHOOK_SECRET'),
  ga4MeasurementId: env('GA4_MEASUREMENT_ID'),
  ga4ApiSecret: env('GA4_API_SECRET'),
  metaPixelId: env('META_PIXEL_ID'),
  metaAccessToken: env('META_CAPI_TOKEN', ['META_ACCESS_TOKEN']),
  tiktokPixelId: env('TIKTOK_PIXEL_ID'),
  tiktokAccessToken: env('TIKTOK_ACCESS_TOKEN'),
  firstPromoterApiKey: env('FP_API_KEY', ['FIRST_PROMOTER_API_KEY']),
  firstPromoterAccountId: env('FP_ACCOUNT_ID', ['FIRST_PROMOTER_ACCOUNT_ID']),
  tasksQueue: env('CLOUD_TASKS_QUEUE'),
  tasksLocation: env('CLOUD_TASKS_LOCATION') || 'us-central1',
  tasksTargetUrl: env('CLOUD_TASKS_TARGET_URL'),
  tasksInvokerServiceAccount: env('CLOUD_TASKS_INVOKER_SA'),
  // Measured, not guessed: the refund fan-out on 2026-08-13 took 40s end to end
  // (First Promoter alone answers in 9-12s, then three Firestore writes). The
  // old 3500 default and the 15000 override both fired while delivery was still
  // succeeding, producing an error log for work that completed fine.
  destinationTimeoutMs: Number(env('DESTINATION_TIMEOUT_MS')) || 90000,
  idempotencyLeaseSeconds: Number(env('IDEMPOTENCY_LEASE_SECONDS')) || 120,
};

export function dependencyStatus() {
  const deps = {
    ga4: Boolean(config.ga4MeasurementId && config.ga4ApiSecret),
    meta: Boolean(config.metaPixelId && config.metaAccessToken),
    tiktok: Boolean(config.tiktokPixelId && config.tiktokAccessToken),
    first_promoter: Boolean(config.firstPromoterApiKey),
    stripe_signature: Boolean(config.stripeWebhookSecret),
    openloop_auth: Boolean(config.openloopSecret),
    firestore: true,
    cloud_tasks: Boolean(config.tasksQueue && config.tasksTargetUrl),
  };

  const missing = Object.entries(deps)
    .filter(([, ok]) => !ok)
    .map(([name]) => name)
    .filter((name) => name !== 'cloud_tasks');

  return { deps, missing };
}
