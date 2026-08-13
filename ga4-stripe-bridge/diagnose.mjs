#!/usr/bin/env node
/**
 * GA4 Measurement Protocol diagnostic ladder.
 *
 * Bisects "purchase is missing from GA4" into the two halves that need
 * completely different fixes:
 *
 *   - GA4 side is broken   -> a hand-built, known-good purchase never lands.
 *   - Pipeline never ran   -> a hand-built purchase lands fine, so the Stripe
 *                             webhook or the Cloud Function is the culprit.
 *
 * Usage:
 *   node diagnose.mjs --measurement-id G-XXXXXXX --api-secret ABC123
 *
 * Options:
 *   --value <number>     purchase value, default 4.18
 *   --currency <code>    default USD
 *   --client-id <id>     reuse a real client_id from the site's _ga cookie
 *   --skip-send          only run the validation step, write nothing to GA4
 */

const MP_HOST = 'https://www.google-analytics.com';
const DEBUG_PATH = '/debug/mp/collect';
const COLLECT_PATH = '/mp/collect';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/** GA4 client_id is "<random>.<seconds>"; the _ga cookie is "GA1.1.<client_id>". */
function newClientId() {
  const random = Math.floor(Math.random() * 1e10);
  return `${random}.${Math.floor(Date.now() / 1000)}`;
}

function normalizeClientId(raw) {
  if (!raw) return newClientId();
  const m = String(raw).match(/^GA\d\.\d\.(.+)$/);
  return m ? m[1] : String(raw);
}

/**
 * A purchase payload with every field GA4 needs for the ecommerce reports to
 * populate: transaction_id drives dedup and the Transactions report, items[]
 * drives Best sellers / item revenue, currency+value drive Purchase revenue.
 */
function buildPurchase({ clientId, transactionId, value, currency, sessionId, debugMode }) {
  const params = {
    transaction_id: transactionId,
    value,
    currency,
    // Standard reports treat an event with no engagement as a non-session hit.
    engagement_time_msec: 100,
    items: [
      {
        item_id: 'diag_sku_001',
        item_name: 'MP Diagnostic Item',
        price: value,
        quantity: 1,
      },
    ],
  };
  if (sessionId) params.session_id = sessionId;
  if (debugMode) params.debug_mode = 1;

  return {
    client_id: clientId,
    // timestamp_micros is deliberately omitted: GA4 stamps arrival time, which
    // removes the seconds-vs-microseconds foot-gun entirely.
    events: [{ name: 'purchase', params }],
  };
}

async function post(path, query, body) {
  const url = `${MP_HOST}${path}?${new URLSearchParams(query)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

function heading(text) {
  console.log(`\n\x1b[1m${text}\x1b[0m`);
  console.log('-'.repeat(text.length));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const measurementId = args['measurement-id'] || process.env.GA4_MEASUREMENT_ID;
  const apiSecret = args['api-secret'] || process.env.GA4_API_SECRET;

  if (!measurementId || !apiSecret) {
    console.error(
      'Missing credentials.\n' +
        '  node diagnose.mjs --measurement-id G-XXXXXXX --api-secret <secret>\n\n' +
        'Both come from GA4 Admin > Data streams > [your web stream].\n' +
        'The API secret must be created on the SAME stream as the measurement ID.'
    );
    process.exit(1);
  }

  if (!/^G-[A-Z0-9]+$/i.test(measurementId)) {
    console.error(
      `Measurement ID "${measurementId}" is not in G-XXXXXXX form.\n` +
        'A "GT-" value is a Google Tag ID and a numeric value is a property ID; ' +
        'neither is accepted by the Measurement Protocol.'
    );
    process.exit(1);
  }

  const value = Number(args.value ?? 4.18);
  const currency = String(args.currency ?? 'USD').toUpperCase();
  const clientId = normalizeClientId(args['client-id']);
  const stamp = Date.now();
  const query = { measurement_id: measurementId, api_secret: apiSecret };

  console.log(`measurement_id : ${measurementId}`);
  console.log(`api_secret     : ${apiSecret.slice(0, 4)}…${apiSecret.slice(-2)}`);
  console.log(`client_id      : ${clientId}${args['client-id'] ? ' (supplied)' : ' (synthetic)'}`);
  console.log(`value          : ${value} ${currency}`);

  // ---- Step 1: schema validation -----------------------------------------
  heading('Step 1  Schema validation (/debug/mp/collect, writes nothing)');

  const validation = await post(
    DEBUG_PATH,
    query,
    buildPurchase({
      clientId,
      transactionId: `diag-validate-${stamp}`,
      value,
      currency,
      sessionId: null,
      debugMode: false,
    })
  );

  let messages = [];
  try {
    messages = JSON.parse(validation.text).validationMessages ?? [];
  } catch {
    console.log(`Unparseable response (HTTP ${validation.status}): ${validation.text}`);
  }

  if (messages.length === 0) {
    console.log('PASS - no schema errors.');
    console.log(
      'Note: this endpoint does NOT verify the api_secret, so a bad secret still ' +
        'passes here. Step 2 is what proves the credentials.'
    );
  } else {
    console.log('FAIL - GA4 rejected the payload:');
    for (const m of messages) {
      console.log(`  [${m.validationCode ?? 'ERROR'}] ${m.fieldPath ?? ''} ${m.description}`);
    }
    console.log('\nFix these before going further; nothing downstream can work.');
    process.exit(2);
  }

  if (args['skip-send']) {
    console.log('\n--skip-send set, stopping before any write.');
    return;
  }

  // ---- Step 2: credential proof via DebugView ----------------------------
  heading('Step 2  Credential proof (real endpoint, debug_mode on)');

  const debugTxn = `diag-debugview-${stamp}`;
  const sent = await post(
    COLLECT_PATH,
    query,
    buildPurchase({
      clientId,
      transactionId: debugTxn,
      value,
      currency,
      sessionId: null,
      debugMode: true,
    })
  );
  console.log(`HTTP ${sent.status} (204 is expected and means nothing on its own)`);
  console.log(`transaction_id: ${debugTxn}`);
  console.log(
    '\nOpen GA4 > Admin > DebugView now. If a "purchase" event appears within ~30s,\n' +
      'the measurement ID, API secret and property are all correct.\n' +
      'If DebugView stays empty, the credentials or the target property are wrong -\n' +
      'that is your bug, and no amount of Cloud Function work will fix it.'
  );

  // ---- Step 3: the session_id A/B ----------------------------------------
  heading('Step 3  session_id A/B (real events, no debug_mode)');

  const withoutId = `diag-no-session-${stamp}`;
  const withId = `diag-with-session-${stamp}`;

  await post(
    COLLECT_PATH,
    query,
    buildPurchase({
      clientId,
      transactionId: withoutId,
      value,
      currency,
      sessionId: null,
      debugMode: false,
    })
  );
  await post(
    COLLECT_PATH,
    query,
    buildPurchase({
      clientId,
      transactionId: withId,
      value,
      currency,
      sessionId: String(Math.floor(Date.now() / 1000)),
      debugMode: false,
    })
  );

  console.log('Sent two purchases that differ only by the session_id parameter:');
  console.log(`  without session_id : ${withoutId}`);
  console.log(`  with session_id    : ${withId}`);
  console.log(
    '\nGA4 has had a long-standing defect where purchase events carrying session_id\n' +
      'are accepted and then never processed. Check Reports > Realtime (event count\n' +
      'by event name), then Transactions once processing catches up, and see which\n' +
      'of the two IDs shows up. That tells you empirically whether your property is\n' +
      'affected - do not guess.'
  );

  heading('What the outcome means');
  console.log(
    'Both land   -> GA4 is healthy. The break is upstream: the Stripe webhook never\n' +
      '               fired, or the Cloud Function errored before calling GA4.\n' +
      '               Check Stripe > Developers > Webhooks (LIVE mode) delivery log\n' +
      '               and the Cloud Function logs for the purchase timestamp.\n\n' +
      'Neither lands -> credentials or property targeting is wrong (see Step 2).\n\n' +
      'Only one lands -> use that shape in the bridge; set SEND_SESSION_ID to match.'
  );
}

main().catch((err) => {
  console.error(`\nDiagnostic failed to run: ${err.message}`);
  process.exit(1);
});
