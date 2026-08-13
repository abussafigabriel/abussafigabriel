export function logInfo(event, fields = {}) {
  console.log(JSON.stringify({
    level: 'info',
    event,
    ts: new Date().toISOString(),
    ...fields,
  }));
}

export function logWarn(event, fields = {}) {
  console.warn(JSON.stringify({
    level: 'warn',
    event,
    ts: new Date().toISOString(),
    ...fields,
  }));
}

export function logError(event, fields = {}) {
  console.error(JSON.stringify({
    level: 'error',
    event,
    ts: new Date().toISOString(),
    ...fields,
  }));
}

export function safeErrorMessage(error) {
  if (!error) return 'unknown_error';
  if (typeof error === 'string') return error.slice(0, 200);
  return String(error.message || error).slice(0, 200);
}
