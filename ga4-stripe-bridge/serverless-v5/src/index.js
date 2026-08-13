import express from 'express';
import { randomUUID } from 'node:crypto';
import { config, dependencyStatus } from './config.js';
import { handleStripeWebhook } from './handlers/stripe.js';
import { handleOpenLoopWebhook } from './handlers/openloop.js';
import { processJob } from './services/tasks.js';
import { logError, safeErrorMessage } from './utils/logging.js';

const app = express();

app.get('/health', (_req, res) => {
  const { deps, missing } = dependencyStatus();
  res.json({
    ok: missing.length === 0,
    service: 'seshdx-tracking',
    version: config.version,
    dependencies: deps,
    missing,
    ts: new Date().toISOString(),
  });
});

app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const started = Date.now();
  try {
    const rawBody = req.body;
    const signature = req.headers['stripe-signature'];
    const result = await handleStripeWebhook(rawBody, signature);
    res.status(result.status).json({
      ...result.body,
      latency_ms: Date.now() - started,
    });
  } catch (error) {
    logError('stripe_route_failed', { error: safeErrorMessage(error) });
    res.status(500).json({ ok: false, error: 'route_failed' });
  }
});

app.post('/webhook/openloop', express.json({ limit: '1mb' }), async (req, res) => {
  const started = Date.now();
  try {
    const result = await handleOpenLoopWebhook(req.body, req.headers);
    res.status(result.status).json({
      ...result.body,
      latency_ms: Date.now() - started,
    });
  } catch (error) {
    logError('openloop_route_failed', { error: safeErrorMessage(error) });
    res.status(500).json({ ok: false, error: 'route_failed' });
  }
});

app.post('/internal/process', express.json({ limit: '1mb' }), async (req, res) => {
  const reqId = randomUUID();
  try {
    const job = req.body;
    const result = await processJob(job);
    res.json({ ok: true, req_id: reqId, result });
  } catch (error) {
    logError('internal_process_failed', { reqId, error: safeErrorMessage(error) });
    res.status(500).json({ ok: false, req_id: reqId, error: 'process_failed' });
  }
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'not_found' });
});

app.listen(config.port, () => {
  console.log(JSON.stringify({
    level: 'info',
    event: 'server_started',
    version: config.version,
    port: config.port,
    ts: new Date().toISOString(),
  }));
});
