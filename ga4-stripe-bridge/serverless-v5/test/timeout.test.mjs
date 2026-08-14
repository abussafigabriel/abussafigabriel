// Exercises the rewritten withTimeout against the four cases that matter.
// The function body is loaded from the real source so the test cannot drift.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/services/tasks.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('function withTimeout'), src.indexOf('/**\n * Delivers a job'));

const logs = [];
const logWarn = (e, f) => logs.push(['warn', e, f]);
const logInfo = (e, f) => logs.push(['info', e, f]);
const logError = (e, f) => logs.push(['error', e, f]);
const withTimeout = new Function('logWarn', 'logInfo', 'logError', `${body}; return withTimeout;`)(logWarn, logInfo, logError);

const sleep = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
const fail = (ms, m) => new Promise((_, rj) => setTimeout(() => rj(new Error(m)), ms));
let pass = 0, total = 0;
const check = (name, cond, extra = '') => { total++; if (cond) { pass++; console.log(`  PASS  ${name}`); } else console.log(`  FAIL  ${name} ${extra}`); };

// 1. finishes before the bound -> real value, no warning
logs.length = 0;
let r = await withTimeout(sleep(20, 'valor'), 500, 'dispatch');
check('fast path returns the real value', r === 'valor', `got ${JSON.stringify(r)}`);
check('fast path logs nothing', logs.length === 0, JSON.stringify(logs));

// 2. rejects before the bound -> propagates
logs.length = 0;
let threw = null;
try { await withTimeout(fail(20, 'boom'), 500, 'dispatch'); } catch (e) { threw = e.message; }
check('fast failure propagates the error', threw === 'boom', String(threw));

// 3. exceeds the bound but succeeds later -> pending, warn now, success later
logs.length = 0;
r = await withTimeout(sleep(300, 'tardio'), 60, 'dispatch');
check('slow path returns pending', r?.pending === true, JSON.stringify(r));
check('slow path warns', logs.some(l => l[0] === 'warn' && l[1] === 'background_dispatch_slow'), JSON.stringify(logs));
check('slow path does NOT log an error yet', !logs.some(l => l[0] === 'error'), JSON.stringify(logs));
await sleep(400);
check('late success is recorded', logs.some(l => l[1] === 'background_dispatch_late_success'), JSON.stringify(logs));
check('late success never becomes an error', !logs.some(l => l[0] === 'error'), JSON.stringify(logs));

// 4. exceeds the bound and then fails -> the real failure still surfaces
logs.length = 0;
r = await withTimeout(fail(300, 'quebrou'), 60, 'dispatch');
check('slow failure returns pending', r?.pending === true, JSON.stringify(r));
await sleep(400);
check('late failure becomes background_dispatch_failed',
  logs.some(l => l[0] === 'error' && l[1] === 'background_dispatch_failed' && l[2].error === 'quebrou'),
  JSON.stringify(logs));

// 5. a rejection after the race must not become an unhandled rejection
process.on('unhandledRejection', (e) => { console.log(`  FAIL  unhandled rejection: ${e?.message}`); process.exitCode = 1; });
await sleep(200);

console.log(`\n${pass}/${total} checks passed`);
if (pass !== total) process.exitCode = 1;
