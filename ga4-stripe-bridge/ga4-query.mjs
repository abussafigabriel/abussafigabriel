#!/usr/bin/env node
/**
 * Queries the GA4 Data API for event counts by event name, so "did GA4 receive
 * the purchase?" is answered from the API instead of from a report screenshot.
 *
 * Runs entirely on your machine. The service account key never leaves it -
 * share only the printed table.
 *
 * Prerequisites:
 *   1. GA4 > Admin > Property access management: add the service account email
 *      as a Viewer.
 *   2. Enable the Google Analytics Data API in the GCP project.
 *
 * Usage:
 *   node ga4-query.mjs --key C:/path/to/claude-debug.json
 *   node ga4-query.mjs --key ./key.json --days 7
 *   node ga4-query.mjs --key ./key.json --transaction pi_3U40tr7nPZQ9eEGQ1xMtBxbP
 */

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

const PROPERTY_ID = '531484467';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';


function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Exchanges a service account key for an access token (RS256 JWT bearer flow). */
async function getAccessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })
  );

  let signature;
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    signature = b64url(signer.sign(key.private_key));
  } catch {
    throw new Error(
      'the private key in the JSON file could not be read. ' +
        'Check that the file is the service account key downloaded from Google Cloud, ' +
        'with "client_email" and "private_key" fields, and not another credential type.'
    );
  }
  const assertion = `${header}.${claims}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(`token exchange failed (HTTP ${res.status}): ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

async function runReport(token, request) {
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY_ID}:runReport`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }
  );
  const body = await res.json();
  if (!res.ok) {
    const msg = body?.error?.message ?? JSON.stringify(body);
    if (res.status === 403) {
      throw new Error(
        `403 from the Data API: ${msg}\n\n` +
          'Usually one of two things:\n' +
          '  - the service account is not a Viewer on the GA4 property, or\n' +
          '  - the Google Analytics Data API is not enabled in the project.'
      );
    }
    throw new Error(`Data API returned HTTP ${res.status}: ${msg}`);
  }
  return body;
}

function table(rows, headers) {
  if (rows.length === 0) return '  (no rows)';
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length))
  );
  const line = (cells) => '  ' + cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

const args = parseArgs(process.argv.slice(2));
if (!args.key) {
  console.error('Missing key:\n  node ga4-query.mjs --key C:/path/key.json [--days 7]');
  process.exit(1);
}

const days = Number(args.days ?? 7);
const key = JSON.parse(readFileSync(args.key, 'utf8'));

console.log(`Property   : ${PROPERTY_ID}`);
console.log(`Account    : ${key.client_email}`);
console.log(`Window     : last ${days} days (property time zone)\n`);

// Wrapped in a function so a failure prints one clear line. A rejected
// top-level await is a module evaluation error, which no process-level
// handler can intercept.
async function main() {
const token = await getAccessToken(key);

// 1. Every event name seen per day - answers "did it land or not".
const byName = await runReport(token, {
  dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
  dimensions: [{ name: 'date' }, { name: 'eventName' }],
  metrics: [{ name: 'eventCount' }],
  dimensionFilter: {
    filter: {
      fieldName: 'eventName',
      inListFilter: { values: ['purchase', 'refund', 'begin_checkout', 'intake_start'] },
    },
  },
  orderBys: [{ dimension: { dimensionName: 'date' }, desc: true }],
  limit: 200,
});

console.log('EVENTS PER DAY');
console.log(
  table(
    (byName.rows ?? []).map((r) => [
      r.dimensionValues[0].value,
      r.dimensionValues[1].value,
      r.metricValues[0].value,
    ]),
    ['date', 'event', 'count']
  )
);

// 2. Revenue metrics alongside the counts: a purchase that landed and was then
//    refunded shows count >= 1 with revenue 0, which is the case to distinguish.
const revenue = await runReport(token, {
  dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
  dimensions: [{ name: 'date' }],
  metrics: [
    { name: 'ecommercePurchases' },
    { name: 'purchaseRevenue' },
    { name: 'refundAmount' },
  ],
  orderBys: [{ dimension: { dimensionName: 'date' }, desc: true }],
  limit: 100,
});

console.log('\nREVENUE PER DAY');
console.log(
  table(
    (revenue.rows ?? []).map((r) => [
      r.dimensionValues[0].value,
      r.metricValues[0].value,
      r.metricValues[1].value,
      r.metricValues[2].value,
    ]),
    ['date', 'purchases', 'revenue', 'refunded']
  )
);

// 3. The specific test transaction, if asked for.
if (typeof args.transaction === 'string') {
  const txn = await runReport(token, {
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
    dimensions: [{ name: 'transactionId' }],
    metrics: [{ name: 'ecommercePurchases' }, { name: 'purchaseRevenue' }],
    limit: 200,
  });

  console.log(`\nTRANSACTIONS (looking for ${args.transaction})`);
  const rows = (txn.rows ?? []).map((r) => [
    r.dimensionValues[0].value,
    r.metricValues[0].value,
    r.metricValues[1].value,
  ]);
  console.log(table(rows, ['transaction_id', 'purchases', 'revenue']));

  const hit = rows.find((r) => r[0] === args.transaction);
  console.log(
    hit
      ? `\n>> FOUND: GA4 received ${args.transaction} (revenue ${hit[2]}).`
      : `\n>> NOT FOUND: ${args.transaction} is not in the property for this window.`
  );
}
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
