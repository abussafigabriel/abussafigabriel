const SKU_MAP = new Map([
  ['weight loss', 'sku-001'],
  ['weight-loss', 'sku-001'],
  ['glp-1', 'sku-001'],
  ['glp1', 'sku-001'],
  ['semaglutide', 'sku-001'],
  ['tirzepatide', 'sku-002'],
  ['default', 'sku-001'],
]);

export function neutralSku(input) {
  const key = String(input || 'default').trim().toLowerCase();
  for (const [needle, sku] of SKU_MAP.entries()) {
    if (key.includes(needle)) return sku;
  }
  return SKU_MAP.get('default');
}

export function centsToMajor(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

export function pickAttribution(source = {}) {
  return {
    sessionId: source.sessionId || source.session_id || '',
    gaClientId: source.gaClientId || source.ga_cid || source.client_id || '',
    fbc: source.fbc || '',
    // OpenLoop sends fbclid, not fbc. Dropping it here left Meta with no
    // click-based match key at all.
    fbclid: source.fbclid || source.fb_clid || '',
    fbp: source.fbp || '',
    ttclid: source.ttclid || '',
    refId: source.refId || source.ref_id || source.fpr || '',
    utmSource: source.utmSource || source.utm_source || '',
    utmMedium: source.utmMedium || source.utm_medium || '',
    utmCampaign: source.utmCampaign || source.utm_campaign || '',
    utmContent: source.utmContent || source.utm_content || '',
    utmTerm: source.utmTerm || source.utm_term || '',
    marketingConsent: source.marketingConsent !== false,
  };
}

export function mergeAttribution(base = {}, overlay = {}) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== undefined && value !== null && value !== '') {
      merged[key] = value;
    }
  }
  return merged;
}
