#!/usr/bin/env node
// AOS shipper: sends this machine's hook events to a central hub (hub/ingest.mjs), so one dashboard can show every machine.
// Zero dependencies, Node 18+ ESM. Outbound HTTPS only; it listens on nothing.
//
//   aos-ship setup <url> [--backfill]   save the hub URL and a machine token (read from stdin) in <live>/ship.json (0600)
//   aos-ship                            run (single instance; started automatically by the plugin's SessionStart hook)
//   aos-ship status | stop
//
// What leaves the machine: the hook's already-sanitized records, with folder and file paths rewritten to
// /aos/p/<project>[/<path inside the project>] (or /aos/x/<folder>/<file> outside a project), transcript paths removed,
// and 'Usage' records holding token counts per model, read here from the local transcripts. Never transcript content.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = process.env.AOS_LIVE_DIR || path.join(ROOT, 'live');
const FILE = path.join(LIVE, 'hook-events.ndjson'), OLD = path.join(LIVE, 'hook-events.1.ndjson');
const CONF = path.join(LIVE, 'ship.json'), STATE = path.join(LIVE, 'ship-state.json'), PID = path.join(LIVE, 'ship.pid');
const TICK_MS = 2000, USAGE_MS = 10000, BATCH_LINES = 500, BATCH_BYTES = 512 * 1024, SESSION_KEEP_MS = 6 * 3600 * 1000;
const HOME = path.resolve(os.homedir());
const KEEP = ['ts', 'ev', 'sid', 'cwd', 'tool', 'agent_id', 'agent_type', 'sum', 'err', 'nt', 'm', 'task'];
const MARKERS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Gemfile', 'CLAUDE.md', '.claude'];

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v) + '\n', { mode: 0o600 }); fs.renameSync(t, f); };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'unknown';
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- project of a folder: the nearest enclosing git repo, else the nearest folder with a project marker ----------
const rootCache = new Map();
function projectRoot(dir) {
  if (rootCache.has(dir)) return rootCache.get(dir);
  let found = null, marker = null;
  const homeOrAbove = (d) => d === '/' || d === HOME || HOME.startsWith(d + '/'); // never a project root
  for (let d = dir; !homeOrAbove(d); d = path.dirname(d)) {
    try {
      if (fs.existsSync(path.join(d, '.git'))) { found = d; break; }
      if (!marker && MARKERS.some((m) => fs.existsSync(path.join(d, m)))) marker = d;
    } catch {}
  }
  const root = found || marker;
  rootCache.set(dir, root); if (rootCache.size > 2000) rootCache.delete(rootCache.keys().next().value);
  return root;
}
const projPath = (root) => '/aos/p/' + slug(path.basename(root));
function mapCwd(cwdp) {
  if (typeof cwdp !== 'string' || !path.isAbsolute(cwdp)) return null;
  const root = projectRoot(cwdp);
  return root ? projPath(root) : '/aos/x/' + slug(path.basename(cwdp) || 'root');
}
function mapFile(f) {
  if (typeof f !== 'string' || !path.isAbsolute(f)) return null;
  const root = projectRoot(path.dirname(f));
  if (root) { const rel = path.relative(root, f); if (rel && !rel.startsWith('..')) return (projPath(root) + '/' + rel).slice(0, 400); }
  return '/aos/x/' + slug(path.basename(path.dirname(f))) + '/' + path.basename(f).slice(0, 80);
}
function transform(r) {
  const o = {};
  for (const k of KEEP) if (r[k] != null) o[k] = r[k];
  const c = mapCwd(r.cwdp); if (c) o.cwdp = c;
  const f = mapFile(r.f); if (f) o.f = f;
  return o;
}

// ---------- token counts from local transcripts (counts + model only, as the monitor does) ----------
const TR = new Map(), seenMsg = new Set();
const zero = () => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
function pump(p) {
  let t = TR.get(p);
  if (!t) { t = { off: 0, carry: Buffer.alloc(0), by: Object.create(null), model: null, sig: '' }; TR.set(p, t); }
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const st = fs.fstatSync(fd);
    if (st.size < t.off) { t.off = 0; t.carry = Buffer.alloc(0); t.by = Object.create(null); }
    let budget = 8 * 1024 * 1024;
    while (t.off < st.size && budget > 0) {
      const len = Math.min(st.size - t.off, 1024 * 1024), buf = Buffer.alloc(len), n = fs.readSync(fd, buf, 0, len, t.off);
      if (n <= 0) break;
      t.off += n; budget -= n;
      const data = Buffer.concat([t.carry, buf.subarray(0, n)]), idx = data.lastIndexOf(10);
      if (idx < 0) { t.carry = data.length > 8e6 ? Buffer.alloc(0) : data; continue; }
      t.carry = Buffer.from(data.subarray(idx + 1));
      for (const l of data.subarray(0, idx).toString('utf8').split('\n')) {
        if (!l.includes('"usage"')) continue;
        try {
          const m = JSON.parse(l).message;
          if (!m || !m.usage || typeof m.usage !== 'object') continue;
          if (m.id) { if (seenMsg.has(m.id)) continue; seenMsg.add(m.id); if (seenMsg.size > 300000) seenMsg.clear(); }
          const u = m.usage, model = typeof m.model === 'string' && m.model !== '<synthetic>' ? m.model.slice(0, 80) : (t.model || 'unknown');
          const b = t.by[model] = t.by[model] || zero();
          b.input += +u.input_tokens || 0; b.output += +u.output_tokens || 0;
          b.cache_read += +u.cache_read_input_tokens || 0; b.cache_write += +u.cache_creation_input_tokens || 0;
          t.model = model;
        } catch {}
      }
    }
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  return t;
}
function usageRecords(sessions) {
  const out = [], now = Date.now();
  const one = (sid, aid, p) => {
    const t = pump(p); if (!t || !t.model) return;
    const sig = JSON.stringify(t.by); if (sig === t.sig) return;
    t.sig = sig;
    out.push({ ts: new Date(now).toISOString(), ev: 'Usage', sid, ...(aid ? { agent_id: aid } : {}), model: t.model, by: t.by });
  };
  for (const [sid, s] of Object.entries(sessions)) {
    if (now - s.last > SESSION_KEEP_MS) { delete sessions[sid]; continue; }
    one(sid, null, s.tp);
    const dir = path.join(path.dirname(s.tp), path.basename(s.tp, '.jsonl'), 'subagents');
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    for (const n of names) { const m = /^agent-([A-Za-z0-9_-]{1,40})\.jsonl$/.exec(n); if (m) one(sid, m[1], path.join(dir, n)); }
  }
  return out;
}

// ---------- reading the local log from a saved offset (follows the hook's one-copy rotation) ----------
function readFrom(st) {
  let file = FILE, cur;
  try { cur = fs.statSync(FILE); } catch { return { lines: [], next: st }; }
  let off = st.off;
  if (st.ino !== cur.ino) {
    let old = null; try { old = fs.statSync(OLD); } catch {}
    if (old && old.ino === st.ino && off < old.size) file = OLD; // finish the rotated copy first
    else { off = 0; st = { ...st, ino: cur.ino, off: 0 }; }
  } else if (cur.size < off) off = 0;
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, len = Math.min(size - off, BATCH_BYTES);
    if (len <= 0) return file === OLD ? { lines: [], next: { ...st, ino: cur.ino, off: 0 } } : { lines: [], next: st };
    const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, off);
    const idx = buf.lastIndexOf(10);
    if (idx < 0) return { lines: [], next: st };
    const lines = buf.subarray(0, idx).toString('utf8').split('\n').slice(0, BATCH_LINES);
    const used = lines.reduce((a, l) => a + Buffer.byteLength(l) + 1, 0);
    return { lines, next: { ...st, ino: file === OLD ? st.ino : cur.ino, off: off + used } };
  } finally { fs.closeSync(fd); }
}

async function post(conf, body) {
  const res = await fetch(conf.url, { method: 'POST', body, signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + conf.token, 'Content-Type': 'application/x-ndjson' } });
  if (!res.ok) throw Object.assign(new Error('hub answered ' + res.status), { status: res.status });
  return res.json();
}

async function run() {
  if (!lock()) return;
  const conf = readJson(CONF);
  if (!conf || !conf.url || !conf.token) { log('not set up: run `aos-ship setup <url>`'); return; }
  let st = readJson(STATE) || {};
  if (st.ino == null) { try { const s = fs.statSync(FILE); st = { ino: s.ino, off: conf.backfill ? 0 : s.size }; } catch { st = { ino: null, off: 0 }; } }
  st.sessions = st.sessions || {};
  let wait = TICK_MS, lastUsage = 0;
  log('shipping', FILE, 'to', new URL(conf.url).host);
  for (;;) {
    await new Promise((r) => setTimeout(r, wait));
    try {
      const { lines, next } = readFrom(st), out = [];
      for (const l of lines) {
        if (!l) continue;
        let r; try { r = JSON.parse(l); } catch { continue; }
        if (!r || typeof r !== 'object' || typeof r.ts !== 'string') continue;
        if (r.sid && typeof r.tp === 'string' && r.tp.endsWith('.jsonl') && !r.agent_id) st.sessions[r.sid] = { tp: r.tp, last: Date.now() };
        else if (r.sid && st.sessions[r.sid]) st.sessions[r.sid].last = Date.now();
        out.push(transform(r));
      }
      if (Date.now() - lastUsage >= USAGE_MS) { lastUsage = Date.now(); out.push(...usageRecords(st.sessions)); }
      if (out.length) await post(conf, out.map((o) => JSON.stringify(o)).join('\n') + '\n');
      st = { ...next, sessions: st.sessions, ok_at: out.length ? new Date().toISOString() : st.ok_at, error: null };
      writeJson(STATE, st);
      wait = lines.length >= BATCH_LINES ? 200 : TICK_MS; // catching up: go again soon
    } catch (e) {
      for (const t of TR.values()) t.sig = ''; // resend usage once the hub is back
      wait = e.status === 401 || e.status === 403 ? 5 * 60000 : Math.min(Math.max(wait * 2, 5000), 60000);
      st.error = String(e.message || e).slice(0, 200); st.error_at = new Date().toISOString();
      try { writeJson(STATE, st); } catch {}
      log('send failed, retrying in', Math.round(wait / 1000) + 's:', st.error);
    }
  }
}

// single instance: ship.pid holds the running shipper's pid
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function lock() {
  fs.mkdirSync(LIVE, { recursive: true, mode: 0o700 });
  const pid = Number((() => { try { return fs.readFileSync(PID, 'utf8'); } catch { return ''; } })());
  if (pid && pid !== process.pid && alive(pid)) return false;
  fs.writeFileSync(PID, String(process.pid), { mode: 0o600 });
  const drop = () => { try { if (Number(fs.readFileSync(PID, 'utf8')) === process.pid) fs.unlinkSync(PID); } catch {} };
  process.on('exit', drop);
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(0));
  return true;
}

async function setup(url, backfill) {
  let u; try { u = new URL(url); } catch { u = null; }
  if (!u || !(u.protocol === 'https:' || (u.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(u.hostname)))) {
    console.error('usage: aos-ship setup https://<hub>/ingest [--backfill]   (token on stdin)'); process.exit(1);
  }
  if (process.stdin.isTTY) process.stderr.write('Paste the machine token, then Enter: ');
  let token = '';
  for await (const c of process.stdin) { token += c; if (token.includes('\n')) break; }
  token = token.trim();
  if (!/^aos_[A-Za-z0-9_-]{43}$/.test(token)) { console.error('\nthat is not an AOS machine token'); process.exit(1); }
  fs.mkdirSync(LIVE, { recursive: true, mode: 0o700 });
  writeJson(CONF, { url: u.href, token, backfill: !!backfill });
  try { fs.unlinkSync(STATE); } catch {}
  console.error(`\nsaved ${CONF} (0600). It starts with your next Claude Code session, or run: aos-ship`);
  process.exit(0);
}

const [cmd, arg] = process.argv.slice(2);
if (!cmd) run().catch((e) => { log('stopped:', e.message); process.exit(1); });
else if (cmd === 'setup') setup(arg, process.argv.includes('--backfill'));
else if (cmd === 'status') {
  const conf = readJson(CONF), st = readJson(STATE) || {}, pid = Number((() => { try { return fs.readFileSync(PID, 'utf8'); } catch { return ''; } })());
  console.log(conf ? `hub:      ${new URL(conf.url).host}` : 'hub:      not set up (aos-ship setup <url>)');
  console.log(`running:  ${pid && alive(pid) ? 'yes (pid ' + pid + ')' : 'no'}`);
  console.log(`last ok:  ${st.ok_at || '-'}`);
  if (st.error) console.log(`error:    ${st.error} (${st.error_at})`);
} else if (cmd === 'stop') {
  const pid = Number((() => { try { return fs.readFileSync(PID, 'utf8'); } catch { return ''; } })());
  if (pid && alive(pid)) { process.kill(pid, 'SIGTERM'); console.log('stopped'); } else console.log('not running');
} else { console.error('usage: aos-ship [setup <url> [--backfill] | status | stop]'); process.exit(1); }
