#!/usr/bin/env node
// AOS hub ingest: receives sanitized hook events that ship/aos-ship.mjs sends from each machine and appends them to
// <AOS_HUB_DATA>/<user>/hook-events.ndjson, the file that user's hub-mode monitor reads. Zero dependencies, Node 18+ ESM.
//
//   node hub/ingest.mjs                          serve POST /ingest (AOS_BIND, default 127.0.0.1; PORT, default 4320)
//   node hub/ingest.mjs add-token <user> <machine>  create a machine token; printed once, only its SHA-256 is kept
//   node hub/ingest.mjs list-tokens              users and machines with a token (never the tokens)
//   node hub/ingest.mjs revoke <user> <machine>  remove a machine's token
//
// Every line is re-validated against a field whitelist; anything unknown is dropped. The machine name comes from the
// token, never from the request. Paths must already be the shipper's /aos/... form, so no local folder layout lands here.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const DATA = path.resolve(process.env.AOS_HUB_DATA || path.join(process.cwd(), 'hub-data'));
const TOKENS = path.join(DATA, 'tokens.json');
const HOST = process.env.AOS_BIND || '127.0.0.1';
const PORT = (() => { const n = Number(process.env.PORT); return Number.isInteger(n) && n > 0 && n < 65536 ? n : 4320; })();
const MAX_BODY = 1024 * 1024, MAX_LINES = 2000, MAX_LINE = 4096, ROTATE_BYTES = 32 * 1024 * 1024;
const RATE_PER_MIN = 120, PAST_MS = 30 * 24 * 3600 * 1000, FUTURE_MS = 5 * 60 * 1000;
const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };

const sha = (s) => createHash('sha256').update(s).digest('hex');
const ctl = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

// ---------- tokens (tokens.json: sha256 -> { user, machine, created }), re-read when it changes ----------
let tokCache = { sig: '', map: {} };
function tokens() {
  try {
    const st = fs.statSync(TOKENS), sig = st.mtimeMs + ':' + st.size;
    if (sig !== tokCache.sig) tokCache = { sig, map: JSON.parse(fs.readFileSync(TOKENS, 'utf8')) || {} };
  } catch { tokCache = { sig: '', map: {} }; }
  return tokCache.map;
}
function saveTokens(map) {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  const tmp = TOKENS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, TOKENS);
}

// ---------- line validation: whitelist only ----------
const STR = { ev: [40, /^[A-Za-z]+$/], sid: [8, /^[A-Za-z0-9-]+$/], cwd: [40], tool: [40], agent_id: [40, /^[A-Za-z0-9_-]+$/],
  agent_type: [40], sum: [80], err: [40, /^[A-Za-z0-9_:.-]+$/], nt: [40, /^[a-z_]+$/], m: [80, /^[A-Za-z0-9._\-\[\]]+$/],
  task: [40, /^[A-Za-z0-9_-]+$/], model: [80] };
const AOS_PATH = /^\/aos\/[^\u0000-\u001f\u007f]{1,395}$/;
function cleanLine(o, machine, now) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (typeof o.ts !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(o.ts)) return null;
  const t = Date.parse(o.ts);
  if (!Number.isFinite(t) || t < now - PAST_MS || t > now + FUTURE_MS) return null;
  const out = { ts: o.ts };
  for (const [k, [n, re]] of Object.entries(STR)) {
    if (o[k] == null) continue;
    if (typeof o[k] !== 'string') return null;
    const v = o[k].replace(ctl, ' ').trim().slice(0, n);
    if (!v || (re && !re.test(v))) continue;
    out[k] = v;
  }
  if (!out.ev) return null;
  for (const k of ['cwdp', 'f']) if (typeof o[k] === 'string' && AOS_PATH.test(o[k]) && !o[k].split('/').includes('..')) out[k] = o[k];
  if (out.ev === 'Usage') {
    if (!out.sid || !o.by || typeof o.by !== 'object' || Array.isArray(o.by)) return null;
    const by = {};
    for (const m of Object.keys(o.by).slice(0, 20)) {
      const u = o.by[m];
      if (!/^[A-Za-z0-9._\-\[\]<>]{1,80}$/.test(m) || !u || typeof u !== 'object') continue;
      const n = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
      by[m] = { input: n(u.input), output: n(u.output), cache_read: n(u.cache_read), cache_write: n(u.cache_write) };
    }
    out.by = by;
  }
  out.host = machine; // from the token, never from the request
  return out;
}

// ---------- append (one write per request), rotating one copy like the hook ----------
function append(user, lines) {
  const dir = path.join(DATA, user);
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  const file = path.join(dir, 'hook-events.ndjson');
  try { if (fs.statSync(file).size > ROTATE_BYTES) fs.renameSync(file, path.join(dir, 'hook-events.1.ndjson')); } catch {}
  fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { mode: 0o640 }); // readable by the monitors' group
}

const rate = new Map(); // token hash -> { min, n }
function limited(h) {
  const min = Math.floor(Date.now() / 60000), r = rate.get(h);
  if (!r || r.min !== min) { rate.set(h, { min, n: 1 }); if (rate.size > 1000) rate.clear(); return false; }
  return ++r.n > RATE_PER_MIN;
}

function send(res, status, obj) { const b = JSON.stringify(obj); res.writeHead(status, { ...HEADERS, 'Content-Length': Buffer.byteLength(b) }); res.end(b); }

function serve() {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/health') return send(res, 200, { ok: true });
    if (pathname !== '/ingest') { req.resume(); return send(res, 404, { error: 'not found' }); }
    if (req.method !== 'POST') { req.resume(); return send(res, 405, { error: 'method not allowed' }); }
    const m = /^Bearer (aos_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
    const h = m && sha(m[1]), who = h && Object.hasOwn(tokens(), h) ? tokens()[h] : null;
    if (!who) { req.resume(); return send(res, 401, { error: 'bad token' }); }
    if (limited(h)) { req.resume(); return send(res, 429, { error: 'slow down' }); }
    if (Number(req.headers['content-length']) > MAX_BODY) { req.resume(); return send(res, 413, { error: 'too large' }); }
    const chunks = []; let size = 0, over = false;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) over = true; else chunks.push(c); });
    req.on('end', () => {
      if (over) return send(res, 413, { error: 'too large' });
      const now = Date.now(), out = []; let dropped = 0;
      const lines = Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean);
      if (lines.length > MAX_LINES) return send(res, 413, { error: 'too many lines' });
      for (const l of lines) {
        let o = null;
        if (l.length <= MAX_LINE) try { o = cleanLine(JSON.parse(l), who.machine, now); } catch {}
        if (o) out.push(o); else dropped++;
      }
      try { if (out.length) append(who.user, out); } catch (e) { console.error('append failed:', e.message); return send(res, 500, { error: 'write failed' }); }
      send(res, 200, { ok: true, accepted: out.length, dropped });
    });
    req.on('error', () => res.destroy());
  });
  server.headersTimeout = 10000; server.requestTimeout = 15000;
  server.listen(PORT, HOST, () => console.log(`AOS hub ingest on http://${HOST}:${PORT}/ingest  (data: ${DATA})`));
  const shutdown = () => { server.close(); setTimeout(() => process.exit(0), 200).unref(); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

const [cmd, user, machine] = process.argv.slice(2);
if (!cmd) serve();
else if (cmd === 'add-token') {
  if (!NAME.test(user || '') || !NAME.test(machine || '')) { console.error('usage: add-token <user> <machine>  (lowercase letters, digits, dashes)'); process.exit(1); }
  const map = { ...tokens() };
  for (const [k, v] of Object.entries(map)) if (v.user === user && v.machine === machine) delete map[k]; // one token per machine
  const tok = 'aos_' + randomBytes(32).toString('base64url');
  map[sha(tok)] = { user, machine, created: new Date().toISOString() };
  saveTokens(map);
  process.stdout.write(tok + '\n');
} else if (cmd === 'list-tokens') {
  for (const v of Object.values(tokens())) console.log(`${v.user}\t${v.machine}\t${v.created}`);
} else if (cmd === 'revoke') {
  const map = { ...tokens() }; let n = 0;
  for (const [k, v] of Object.entries(map)) if (v.user === user && v.machine === machine) { delete map[k]; n++; }
  saveTokens(map); console.log(`revoked ${n}`);
} else { console.error('usage: ingest.mjs [add-token <user> <machine> | list-tokens | revoke <user> <machine>]'); process.exit(1); }
