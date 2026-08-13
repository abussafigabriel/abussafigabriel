import { CloudTasksClient } from '@google-cloud/tasks';
import { config } from '../config.js';
import { logError, logInfo, logWarn } from '../utils/logging.js';
import { dispatchEvent } from './dispatch.js';

let tasksClient;

function getTasksClient() {
  if (!tasksClient) tasksClient = new CloudTasksClient();
  return tasksClient;
}

export function shouldUseCloudTasks() {
  return Boolean(config.tasksQueue && config.tasksTargetUrl);
}

export async function enqueueEvent(job) {
  const client = getTasksClient();
  const parent = client.queuePath(config.projectId, config.tasksLocation, config.tasksQueue);
  const payload = Buffer.from(JSON.stringify(job)).toString('base64');

  const task = {
    httpRequest: {
      httpMethod: 'POST',
      url: `${config.tasksTargetUrl.replace(/\/$/, '')}/internal/process`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: payload,
      oidcToken: config.tasksInvokerServiceAccount
        ? { serviceAccountEmail: config.tasksInvokerServiceAccount }
        : undefined,
    },
  };

  const [response] = await client.createTask({ parent, task });
  logInfo('cloud_task_enqueued', {
    taskName: response.name,
    source: job.source,
    eventType: job.eventType,
  });
  return response;
}

export async function processJob(job) {
  return dispatchEvent(job);
}

/**
 * Bounds how long we wait on a job WITHOUT pretending the job died.
 *
 * Promise.race cannot cancel the work it loses to; the fan-out kept running and
 * kept succeeding, so the old version logged background_dispatch_failed for
 * deliveries that completed seconds later. Both test purchases on 2026-08-13
 * show exactly that: a timeout error followed by a fully successful
 * *_dispatched with all four destinations at 200/204.
 *
 * The bound is still useful — it stops a wedged job from pinning the request —
 * but exceeding it is a warning about latency, and the real outcome is always
 * reported when it lands.
 */
function withTimeout(promise, ms, label) {
  let timer;
  let settled = false;

  const outcome = promise.then(
    (value) => { settled = true; return { late: true, ok: true, value }; },
    (error) => { settled = true; return { late: true, ok: false, error }; },
  );

  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });

  return Promise.race([
    outcome.then((r) => { clearTimeout(timer); return r; }),
    timeout,
  ]).then((first) => {
    if (!first.timedOut) {
      if (first.ok) return first.value;
      throw first.error;
    }

    logWarn('background_dispatch_slow', {
      label,
      thresholdMs: ms,
      note: 'entrega ainda em andamento; resultado real sera registrado ao concluir',
    });

    // Report what actually happened once the work finishes, so a slow delivery
    // is never mistaken for a lost one.
    outcome.then((r) => {
      if (r.ok) logInfo('background_dispatch_late_success', { label, thresholdMs: ms });
      else logError('background_dispatch_failed', { label, error: r.error?.message });
    });

    return { pending: true, thresholdMs: ms };
  }).finally(() => { if (settled) clearTimeout(timer); });
}

/**
 * Delivers a job to its destinations.
 *
 * This used to hand the job to setImmediate and return. On Cloud Run, CPU is
 * throttled once the response is sent, so that work was never guaranteed to
 * run — four outbound HTTP calls per purchase, in exactly the window where
 * the container may be frozen. Delivery is now awaited and bounded, which
 * makes it both reliable and visible in the logs.
 *
 * Cloud Tasks stays the preferred path when a queue is configured; inline
 * delivery is the fallback (today the Cloud Tasks API is not even enabled).
 */
export async function scheduleBackground(job) {
  if (shouldUseCloudTasks()) {
    try {
      await enqueueEvent(job);
      return { ok: true, queued: true };
    } catch (error) {
      logError('cloud_task_enqueue_failed', {
        source: job.source,
        eventType: job.eventType,
        error: error.message,
      });
    }
  }

  try {
    const result = await withTimeout(processJob(job), config.destinationTimeoutMs, 'dispatch');
    return { ok: true, delivered: true, result };
  } catch (error) {
    logError('background_dispatch_failed', {
      source: job.source,
      eventType: job.eventType,
      error: error.message,
    });
    return { ok: false, delivered: false, error: error.message };
  }
}
