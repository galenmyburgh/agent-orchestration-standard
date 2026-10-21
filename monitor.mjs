// AOS-1 read-only live monitor: folds Claude Code hook events (live/hook-events.ndjson) into an AOS-1 /api/state view.
// Zero dependencies, Node 18+ ESM. Binds 127.0.0.1 only, unless AOS_BIND is set (hub mode: inside a container behind a proxy,
// reading the per-user log that hub/ingest.mjs writes; see hub/README.md).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(ROOT, 'ui');
const LIVE = process.env.AOS_LIVE_DIR || path.join(ROOT, 'live');
const FILE = path.join(LIVE, 'hook-events.ndjson');
const PORT = (() => { const n = Number(process.env.PORT); return Number.isInteger(n) && n > 0 && n < 65536 ? n : 4318; })();
const HOST = process.env.AOS_BIND || '127.0.0.1';
// hub mode: the public hostnames this monitor is served on, accepted in Host/Origin besides localhost
const ALLOWED_HOSTS = new Set(String(process.env.AOS_ALLOWED_HOSTS || '').toLowerCase().split(',').map((h) => h.trim()).filter(Boolean));
const RUN_S = 900, SESSION_TTL_S = 3600, STALE_SUB_S = 600, INTERVAL_S = 30, TAIL_LINES = 2000, TAIL_BYTES = 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };
const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
const GOAL_ID = 'live-goal';

// ---------- config / prices (mtime cached) ----------
const jsonCache = new Map();
function readJson(file) {
  try {
    const st = fs.statSync(file), c = jsonCache.get(file);
    if (c && c.m === st.mtimeMs && c.s === st.size) return c.v;
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    jsonCache.set(file, { m: st.mtimeMs, s: st.size, v });
    return v;
  } catch { return null; }
}
// projects: {"folderName": "Display Name"}; anything malformed is ignored
function aliasMap(o) {
  const m = new Map();
  if (!o || typeof o !== 'object' || Array.isArray(o)) return m;
  for (const k of Object.keys(o)) {
    const key = k.trim(), v = o[k], name = typeof v === 'string' ? v.trim() : '';
    if (!key || key.length > 200 || !name || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) continue;
    m.set(key, name);
    if (m.size >= 200) break;
  }
  return m;
}
// per-model-family stuck thresholds (seconds); families are matched in the model id, case-insensitively
const FAMS = ['opus', 'sonnet', 'haiku'], FAM_DEFAULT = { opus: 600, sonnet: 240, haiku: 180 };
const modelFam = (m) => { if (typeof m !== 'string') return null; const x = m.toLowerCase(); return FAMS.find((f) => x.includes(f)) || null; };
function byModelCfg(o) {
  const out = { ...FAM_DEFAULT };
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  for (const k of Object.keys(o)) { const v = o[k]; if (FAMS.includes(k) && typeof v === 'number' && Number.isFinite(v) && v >= 5) out[k] = v; }
  return out;
}
function cfg() {
  const c = readJson(path.join(LIVE, 'config.json')) || {}, n = c.notify || {};
  const st = Number(c.stuck_after_s);
  const base = Number.isFinite(st) && st >= 5 ? st : 180, byModel = byModelCfg(c.stuck_after_s_by_model);
  return { stuck: base, byModel, minStuck: Math.min(base, ...Object.values(byModel)),
    errIdleS: 60, errRunLen: 3, errWinMs: 5 * 60 * 1000,
    notify: { enabled: n.enabled === true, on: Array.isArray(n.on) ? n.on.filter((k) => typeof k === 'string') : ['needs_input', 'stuck'], sound: n.sound === true },
    projects: aliasMap(c.projects) };
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'unknown';
function priceFor(model) {
  const pr = readJson(path.join(LIVE, 'prices.json'));
  if (!pr || !model) return null;
  let best = null;
  for (const k of Object.keys(pr)) if (!k.startsWith('_') && pr[k] && typeof pr[k] === 'object' && model.startsWith(k) && (!best || k.length > best.length)) best = k;
  const p = best && pr[best];
  return p && Number.isFinite(p.input) && Number.isFinite(p.output) ? p : null;
}
function modelLabel(id) {
  if (!id || typeof id !== 'string' || id === 'unknown') return null;
  let m = id.replace(/\[[^\]]*\]/g, '').replace(/-\d{8}$/, '').replace(/^claude-/, '').trim();
  if (!m) return null;
  const cap = (f) => f[0].toUpperCase() + f.slice(1);
  let x = m.match(/^([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/);
  if (x) return `${cap(x[1])} ${x[2]}${x[3] ? '.' + x[3] : ''}`;
  x = m.match(/^(\d+)(?:-(\d{1,2}))?-([a-z]+)$/);
  if (x) return `${cap(x[3])} ${x[1]}${x[2] ? '.' + x[2] : ''}`;
  return m;
}
const zero = () => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
const add = (a, b) => { a.input += b.input; a.output += b.output; a.cache_read += b.cache_read; a.cache_write += b.cache_write; return a; };
function usd(u, model) {
  const p = priceFor(model);
  if (!p) return null;
  return Math.round(((u.input * p.input + u.output * p.output + u.cache_read * (p.cache_read || 0) + u.cache_write * (p.cache_write || 0)) / 1e6) * 1e6) / 1e6;
}

// ---------- incremental ndjson ingest (bounded) ----------
const MAX_RECS = 50000;
let recs = [], off = 0, ino = null, carry = Buffer.alloc(0), ingestSig = '';
const tpSess = new Map(), tpAgent = new Map(); // sid -> transcript path ; sid:agent_id -> path
// hub mode: token totals shipped from each machine as 'Usage' records (the transcripts stay on the machines).
// Key 'remote:<sid>[:<agent_id>]' -> { tot, by, model }, the same shape pump() returns.
const REMOTE = new Map();
function usage1(r) {
  if (typeof r.sid !== 'string' || !r.by || typeof r.by !== 'object' || Array.isArray(r.by)) return;
  const t = { tot: zero(), by: Object.create(null), model: typeof r.model === 'string' ? r.model.slice(0, 80) : null };
  const n = (v) => (Number.isFinite(+v) && +v > 0 ? +v : 0);
  for (const m of Object.keys(r.by).slice(0, 20)) {
    const u = r.by[m];
    if (!u || typeof u !== 'object') continue;
    const d = { input: n(u.input), output: n(u.output), cache_read: n(u.cache_read), cache_write: n(u.cache_write) };
    add(t.by[m.slice(0, 80)] = t.by[m.slice(0, 80)] || zero(), d); add(t.tot, d);
  }
  const k = 'remote:' + r.sid + (typeof r.agent_id === 'string' && r.agent_id ? ':' + r.agent_id : '');
  REMOTE.delete(k); REMOTE.set(k, t);
  if (REMOTE.size > 5000) REMOTE.delete(REMOTE.keys().next().value);
}
function ingest1(r) {
  if (!r || typeof r !== 'object' || typeof r.ts !== 'string' || !Number.isFinite(Date.parse(r.ts))) return;
  if ((r.sid != null && typeof r.sid !== 'string') || (r.f != null && typeof r.f !== 'string')) return; // fold() needs strings here
  if (r.ev === 'Usage') return usage1(r);
  if (recs.length && r.ts < recs[recs.length - 1].ts) { // hub mode: a machine catching up after being offline; keep recs in time order
    let lo = 0, hi = recs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (recs[mid].ts <= r.ts) lo = mid + 1; else hi = mid; }
    recs.splice(lo, 0, r);
  } else recs.push(r);
  if (typeof r.tp === 'string' && r.tp.endsWith('.jsonl') && path.isAbsolute(r.tp) && r.sid) {
    if (r.ev === 'SubagentStop' && r.agent_id) tpAgent.set(r.sid + ':' + r.agent_id, r.tp); else if (!r.agent_id) tpSess.set(r.sid, r.tp);
  }
}
function ingest() {
  let fd;
  try {
    fd = fs.openSync(FILE, 'r');
    const st = fs.fstatSync(fd);
    if (st.size < off || (ino !== null && st.ino !== ino)) { off = 0; carry = Buffer.alloc(0); } // rotated (new inode) or truncated
    ino = st.ino;
    let budget = 16 * 1024 * 1024;
    while (off < st.size && budget > 0) {
      const len = Math.min(st.size - off, 1024 * 1024), buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, off);
      if (n <= 0) break;
      off += n; budget -= n;
      const data = Buffer.concat([carry, buf.subarray(0, n)]), idx = data.lastIndexOf(10);
      if (idx < 0) { carry = data.length > 1e6 ? Buffer.alloc(0) : data; continue; }
      carry = Buffer.from(data.subarray(idx + 1));
      for (const l of data.subarray(0, idx).toString('utf8').split('\n')) { if (!l) continue; try { ingest1(JSON.parse(l)); } catch {} }
    }
    if (recs.length > MAX_RECS) recs = recs.slice(-Math.floor(MAX_RECS * 0.8));
    ingestSig = st.size + ':' + st.mtimeMs;
  } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// ---------- transcript usage (counts + model only) ----------
const TR = new Map(), seenMsg = new Set();
function pump(p) {
  if (p.startsWith('remote:')) return REMOTE.get(p) || null;
  let t = TR.get(p);
  if (!t) { t = { off: 0, carry: Buffer.alloc(0), tot: zero(), by: Object.create(null), model: null, last: 0 }; TR.set(p, t); if (TR.size > 500) TR.delete(TR.keys().next().value); }
  const now = Date.now();
  if (now - t.last < 2000) return t;
  t.last = now;
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const st = fs.fstatSync(fd);
    if (st.size < t.off) { t.off = 0; t.carry = Buffer.alloc(0); t.tot = zero(); t.by = Object.create(null); }
    let budget = 32 * 1024 * 1024;
    while (t.off < st.size && budget > 0) {
      const len = Math.min(st.size - t.off, 1024 * 1024), buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, t.off);
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
          const u = m.usage, d = { input: +u.input_tokens || 0, output: +u.output_tokens || 0, cache_read: +u.cache_read_input_tokens || 0, cache_write: +u.cache_creation_input_tokens || 0 };
          const model = typeof m.model === 'string' && m.model !== '<synthetic>' ? m.model.slice(0, 80) : (t.model || 'unknown');
          t.model = model; add(t.tot, d); add(t.by[model] = t.by[model] || zero(), d);
        } catch {}
      }
    }
  } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  return t;
}
function trPath(sid, agentId) {
  const rk = 'remote:' + sid + (agentId ? ':' + agentId : '');
  if (REMOTE.has(rk)) return rk;
  if (agentId) {
    const k = sid + ':' + agentId;
    if (tpAgent.has(k)) return tpAgent.get(k);
    const main = tpSess.get(sid); // derive nested subagent transcript while running
    if (main && /^[A-Za-z0-9_-]+$/.test(agentId)) {
      const d = path.join(path.dirname(main), path.basename(main, '.jsonl'), 'subagents', 'agent-' + agentId + '.jsonl');
      try { if (fs.existsSync(d)) return d; } catch {}
    }
    return null;
  }
  return tpSess.get(sid) || null;
}

// ---------- project roots (from 'cwdp': full cwd paths; used only for grouping, never exposed) ----------
const HOME = path.resolve(os.homedir());
const under = (d, base) => base === '/' || d === base || d.startsWith(base + '/');
const comps = (d) => d.split('/').filter(Boolean).length;
const GENERIC_UNDER = ['/private/var/folders', '/tmp'];
const isGeneric = (d) => d === '/' || under(HOME, d) || comps(d) < 3 || GENERIC_UNDER.some((g) => under(d, g));
function normCwdp(v) { // absolute, <= 300 chars, no control chars; trailing slashes removed; anything else ignored
  if (typeof v !== 'string' || v.length > 300 || /[\u0000-\u001f\u007f]/.test(v) || !path.isAbsolute(v)) return null;
  return path.posix.normalize(v).replace(/\/+$/, '') || '/';
}
// project-root markers: a directory holding one of these is a project root (home and its ancestors never count)
const MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Gemfile', 'CLAUDE.md', '.claude'];
const MARK_TTL_MS = 60 * 1000;
const markCache = new Map(); // dir -> { t, has }: stat results, expire after 60s
function hasMarker(d) {
  const now = Date.now(), c = markCache.get(d);
  if (c && now - c.t < MARK_TTL_MS) return c.has;
  let has = false;
  try { has = MARKERS.some((f) => fs.existsSync(path.join(d, f))); } catch { has = false; }
  markCache.set(d, { t: now, has });
  if (markCache.size > 2000) markCache.delete(markCache.keys().next().value);
  return has;
}
// m: Map(cwdp -> event count). Among non-generic ancestor-or-self candidates with coverage >= 0.6: the shallowest one that is a
// project root (has a marker); else the shallowest candidate; else the most frequent cwdp (generic -> home)
function deriveRoot(m, n) {
  const cands = new Set();
  for (const c of m.keys()) {
    if (c === '/') continue;
    const parts = c.split('/');
    let acc = '';
    for (let i = 1; i < parts.length; i++) { acc += '/' + parts[i]; if (!isGeneric(acc)) cands.add(acc); }
  }
  const ok = [];
  for (const d of cands) {
    let cov = 0;
    for (const [c, v] of m) if (under(c, d)) cov += v;
    if (cov / n >= 0.6) ok.push(d);
  }
  ok.sort((a, b) => comps(a) - comps(b) || (a < b ? -1 : a > b ? 1 : 0)); // shallowest first, alphabetical within a depth
  let best = ok.length ? ok[0] : null;
  for (const d of ok) if (!under(HOME, d) && hasMarker(d)) { best = d; break; }
  if (best) return best;
  const top = [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0][0];
  return isGeneric(top) ? HOME : top;
}
const RC = new Map(); // sid -> { sig, root }: derivation cache, keyed by the event counts per cwdp
function projectInfo(sid, cwpM, cwM, C) {
  if (cwpM && cwpM.size) {
    let n = 0, sig = '';
    for (const [c, v] of cwpM) { n += v; sig += c + '\u0000' + v + '\u0001'; }
    let hit = RC.get(sid);
    if (!hit || hit.sig !== sig) {
      hit = { sig, root: deriveRoot(cwpM, n) };
      RC.set(sid, hit); if (RC.size > 5000) RC.delete(RC.keys().next().value);
    }
    const root = hit.root, base = path.basename(root);
    return { key: 'p:' + root, root, base, alias: C.projects.get(root) || C.projects.get(base) || null };
  }
  // no cwdp at all (older log lines): modal cwd basename, unchanged
  let best = null, bn = 0;
  for (const [c, n] of cwM || []) if (n > bn) { best = c; bn = n; }
  return best ? { key: 'b:' + best, root: null, base: best, alias: C.projects.get(best) || null } : { key: 'b:unknown', root: null, base: 'unknown', alias: null };
}
// names/ids for the projects visible in this view; a shared id or display name gets disambiguated
function finalNames(visible, rank) {
  const fin = new Map();
  for (const [k, p] of visible) { const name = p.alias || p.base; fin.set(k, { name, id: slug(name) }); }
  const group = (f) => { const g = new Map(); for (const [k, v] of fin) { const x = f(v); if (!g.has(x)) g.set(x, []); g.get(x).push(k); } return g; };
  for (const ks of group((v) => v.id).values()) if (ks.length > 1) for (const k of ks) { const f = fin.get(k); f.id = f.id + '-' + createHash('sha1').update(k).digest('hex').slice(0, 8); }
  for (const ks of group((v) => v.name).values()) if (ks.length > 1) {
    ks.sort((a, b) => rank.get(a) - rank.get(b));
    for (const k of ks.slice(1)) { const p = visible.get(k); if (p.root) fin.get(k).name += ` (${path.basename(path.dirname(p.root))})`; }
  }
  return fin;
}

// ---------- fold ----------
const FOLD_N = 5000, WIN_MS = 5 * 60 * 1000, OPEN_MAX_MS = 30 * 60 * 1000;
const MAIN_RUN = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure']); // main-session events that open a run segment
const runS = (ms) => Math.max(0, Math.round(ms / 1000));
const tokPerMin = (rs, u, have) => (have && rs >= 10 ? Math.round((u.input + u.output + u.cache_write) / (rs / 60)) : null);
const NI_IGNORE = new Set(['idle_prompt', 'auth_success', 'elicitation_complete', 'elicitation_response', 'quota_auto_resume_fired', 'quota_auto_resume_stale', 'quota_auto_resume_disabled', 'agent_completed']);

function fold(list, ref) {
  const C = cfg(), onSet = new Set(C.notify.on);
  const sessions = new Map(), subs = new Map(), events = [], alerts = [], markers = [], files = new Map(), collided = new Map();
  const cw = new Map(); // sid -> Map(cwd basename -> event count); Map order = first seen, used for the project tie-break
  const cwp = new Map(); // sid -> Map(cwdp -> event count): full cwd paths, used only for project roots
  const ev = (ts, type, actor, task_id, data) => events.push({ ts, seq: 0, type, actor, goal_id: GOAL_ID, task_id, data });
  const alert = (ms, kind, agent, text) => {
    if (kind !== 'needs_input' && kind !== 'stuck' && !onSet.has(kind)) return;
    const ts = new Date(ms).toISOString(); alerts.push({ ts, kind, agent, text }); ev(ts, 'alert', agent, null, { kind, text });
  };
  const mk = (ms, type) => markers.push({ ts: new Date(ms).toISOString(), type });
  const subsRunning = (sid) => { for (const x of subs.values()) if (x.sid === sid && !x.done) return true; return false; };
  const mkTools = () => ({ pend: [], recent: [] });
  const closeTool = (T, name, t) => {
    let i = -1; for (let j = T.pend.length - 1; j >= 0; j--) if (T.pend[j].name === name) { i = j; break; }
    const e = i >= 0 ? T.pend.splice(i, 1)[0] : null;
    T.recent.push({ ts: new Date(e ? e.t : t).toISOString(), name, summary: e ? e.summary : '', ms: e ? t - e.t : null });
    if (T.recent.length > 15) T.recent.shift();
  };
  // stuck threshold (ms) for an actor, by its transcript's model family; unknown model (no transcript yet) = base threshold
  const thrMs = (sid, aid) => { const p = trPath(sid, aid || null), tr = p ? pump(p) : null, fam = modelFam(tr && tr.model); return (fam ? C.byModel[fam] : C.stuck) * 1000; };
  // errored state: a StopFailure (a.err) clears on success; tool failures (a.tkind) need 3 in a row or a failure followed by 60s of silence
  const okEv = (a) => { a.err = null; a.tn = 0; a.tkind = null; };
  const errOf = (a, ref, label) => {
    if (a.err) return a.err;
    if (!a.tkind) return null;
    if ((a.tn || 0) >= C.errRunLen) return a.tkind;
    if (a.evFail && ref - a.evT >= C.errIdleS * 1000) { const at = a.evT + C.errIdleS * 1000; alert(at, 'error', label, `${label} tool failed (${a.tkind}) and went quiet`); mk(at, 'error'); return a.tkind; }
    return null;
  };
  const recentF = (a, ref) => { let n = 0; for (const x of a.ft || []) if (x <= ref && x > ref - C.errWinMs) n++; return n; };
  // inactivity gap check before an actor's next activity at t
  const gapCheck = (a, label, t, running, sid, aid) => {
    if (!running || a.wait || !a.act || t - a.act <= C.minStuck * 1000) return;
    const thr = thrMs(sid, aid) * (a.tools.pend.length ? 2 : 1);
    if (t - a.act > thr) { alert(a.act + thr, 'stuck', label, `${label} had no activity for ${Math.round(thr / 1000)}s`); mk(a.act + thr, 'stuck'); }
  };
  const touchFile = (f, label, t) => {
    let m = files.get(f);
    if (!m) { m = new Map(); files.set(f, m); if (files.size > 2000) files.delete(files.keys().next().value); }
    for (const [who, ts] of m) if (who !== label && t - ts <= WIN_MS) {
      const lc = collided.get(f); if (!lc || t - lc > WIN_MS) { collided.set(f, t); mk(t, 'collision'); }
      break;
    }
    m.delete(label); m.set(label, t);
  };

  for (const r of list) {
    const t = Date.parse(r.ts), sid = r.sid || 'unknown', name = r.ev;
    let s = sessions.get(sid);
    if (!s) { s = { sid, cwd: r.cwd || '', id: (typeof r.host === 'string' && r.host ? r.host : 'Claude Code') + '·' + sid.slice(0, 4), last: t, active: 0, ended: false, act: 0, wait: false, tools: mkTools(), first: t, seg: null, closed: 0 }; sessions.set(sid, s); }
    if (r.cwd) s.cwd = r.cwd;
    if (typeof r.cwd === 'string') { const c = r.cwd.trim().slice(0, 200); if (c) { let m = cw.get(sid); if (!m) cw.set(sid, m = new Map()); m.set(c, (m.get(c) || 0) + 1); } }
    const cp = normCwdp(r.cwdp); if (cp) { let m = cwp.get(sid); if (!m) cwp.set(sid, m = new Map()); m.set(cp, (m.get(cp) || 0) + 1); }
    if (name === 'SessionStart' && r.m && !s.mdl) s.mdl = r.m;
    const prevLast = s.last;
    s.last = t;
    const sub = r.agent_id ? subs.get(sid + ':' + r.agent_id) : null;
    const actor = sub || s, label = sub ? sub.id : s.id;
    const wasFail = !!actor.evFail; actor.evT = t; actor.evFail = false; // last event of this actor (errored rule c)
    if (!r.agent_id) { // main session run segments: prompt/tool activity -> Stop; a silent gap longer than RUN_S ends the run (idle time not counted)
      if (s.seg !== null && t - prevLast > RUN_S * 1000) { s.closed += Math.max(0, prevLast - s.seg); s.seg = null; }
      if (name === 'Stop' || name === 'StopFailure' || name === 'SessionEnd') { if (s.seg !== null) { s.closed += Math.max(0, t - s.seg); s.seg = null; } }
      else if (s.seg === null && (MAIN_RUN.has(name) || (t === s.first && name !== 'SessionStart'))) s.seg = t;
    }
    const isAct = name === 'PreToolUse' || name === 'PostToolUse' || name === 'UserPromptSubmit' || name === 'SessionStart' || name === 'SubagentStart' || name === 'Notification' || name === 'PermissionRequest' || name === 'PostToolUseFailure';
    if (isAct && name !== 'SubagentStart' && name !== 'SessionStart') gapCheck(actor, label, t, sub ? !sub.done : (s.active > 0 && !subsRunning(sid)), sid, sub ? sub.aid : null);
    if (name === 'SessionStart') { s.ended = false; s.act = t; mk(t, 'session.start'); ev(r.ts, 'agent.spawned', s.id, null, { agent: s.id, role: 'main session', cwd: s.cwd }); }
    else if (name === 'SessionEnd') s.ended = true;
    else if (name === 'Stop') {
      s.active = 0; s.tools.pend = []; s.wait = false; okEv(s);
      alert(t, 'session_done', s.id, `${s.id} finished its turn`);
    }
    else if (name === 'UserPromptSubmit') { s.active = t; s.act = t; s.wait = false; okEv(s); ev(r.ts, 'human.note', 'human', null, { text: 'prompt submitted', session: s.id }); }
    else if (name === 'StopFailure') {
      const k = r.err || 'unknown'; s.active = 0; s.tools.pend = []; s.wait = false; s.err = k;
      mk(t, 'error');
      alert(t, 'error', s.id, `${s.id} turn failed (${k})`);
    }
    else if (name === 'PostToolUseFailure') {
      if (sub) { sub.last = t; if (s.active) s.active = t; } else s.active = t;
      actor.act = t; actor.wait = false; closeTool(actor.tools, r.tool || '?', t);
      if (r.err !== 'interrupted') {
        // a single failure is routine noise: errored only after 3 in a row, or one followed by 60s of silence (see errOf)
        const k = (r.tool ? String(r.tool).slice(0, 40) + ':' : '') + (r.err || 'tool_failed');
        actor.tkind = k; actor.tn = (actor.tn || 0) + 1; actor.evFail = true;
        (actor.ft = actor.ft || []).push(t); if (actor.ft.length > 200) actor.ft.shift();
        if (actor.tn === C.errRunLen) { alert(t, 'error', label, `${label} tool failed (${k}) ${C.errRunLen} times in a row`); mk(t, 'error'); }
      }
    }
    else if (name === 'PermissionRequest') {
      actor.act = t; actor.wait = true;
      alert(t, 'needs_input', label, `${label} needs input (permission_request)`);
    }
    else if (name === 'TaskCreated' || name === 'TaskCompleted') {
      ev(r.ts, name === 'TaskCreated' ? 'task.created' : 'task.completed', label, null, { agent: label, ...(r.task ? { claude_task: r.task } : {}), source: 'claude-code-task-list' });
    }
    else if (name === 'PreModelSwitch' || name === 'PostModelSwitch') {
      if (name === 'PostModelSwitch' && r.m) actor.mdl = r.m;
    }
    else if (name === 'Notification') {
      actor.act = t; actor.wait = true;
      if (r.nt && !NI_IGNORE.has(r.nt) || !r.nt) alert(t, 'needs_input', label, `${label} needs input${r.nt ? ' (' + r.nt + ')' : ''}`);
    }
    else if (name === 'PreToolUse' || name === 'PostToolUse') {
      if (name === 'PreToolUse' && (r.tool === 'Agent' || r.tool === 'Task') && r.sum && !r.agent_id) (s.pend = s.pend || []).push(String(r.sum));
      if (sub) { sub.last = t; if (s.active) s.active = t; } else s.active = t;
      actor.act = t; actor.wait = false;
      if (name === 'PreToolUse') {
        actor.tools.pend.push({ name: r.tool || '?', summary: r.sum || '', t });
        if (actor.tools.pend.length > 20) actor.tools.pend.shift();
        if (r.f) { touchFile(r.f, label, t); }
      } else { closeTool(actor.tools, r.tool || '?', t); okEv(actor); }
    } else if (name === 'SubagentStart' && r.agent_id) {
      const k = sid + ':' + r.agent_id, prev = subs.get(k), desc = prev ? '' : (s.pend && s.pend.shift()) || '', id = prev ? prev.id : (desc || r.agent_type || 'subagent') + '·' + String(r.agent_id).slice(0, 4); // resumed agents keep their name
      if (prev) { prev.done = false; okEv(prev); prev.last = t; prev.act = t; prev.wait = false; if (prev.segOpen === null) prev.segOpen = t; }
      else subs.set(k, { id, sid, aid: r.agent_id, role: r.agent_type || 'subagent', title: r.agent_type || 'subagent', start: t, last: t, act: t, wait: false, done: false, ts: r.ts, tools: mkTools(), segOpen: t, ranMs: 0, endMs: null });
      ev(r.ts, 'agent.spawned', s.id, 't-' + id, { agent: id, role: r.agent_type || 'subagent', parent: s.id });
      ev(r.ts, 'task.started', id, 't-' + id, { title: r.agent_type || 'subagent' });
      mk(t, 'agent.spawned'); mk(t, 'task.started');
    } else if (name === 'SubagentStop' && r.agent_id) {
      if (sub) { sub.done = true; sub.failed = !!(sub.err || wasFail || (sub.tn || 0) >= C.errRunLen); sub.last = t; sub.end = r.ts; sub.endMs = t; if (sub.segOpen !== null) { sub.ranMs += Math.max(0, t - sub.segOpen); sub.segOpen = null; } sub.tools.pend = []; ev(r.ts, 'task.completed', sub.id, 't-' + sub.id, { agent: sub.id }); mk(t, 'task.completed'); alert(t, 'agent_done', sub.id, `${sub.id} finished`); }
    }
  }

  const iso = (ms) => new Date(ms).toISOString();
  const cut = ref - WIN_MS;
  const touched = new Map(); // label -> [{f,ts}]
  const collisions = [];
  for (const [f, m] of files) {
    const live = [...m].filter(([, ts]) => ts >= cut && ts <= ref);
    for (const [who, ts] of live) { if (!touched.has(who)) touched.set(who, []); touched.get(who).push({ f, ts }); }
    // file: parent folder + basename only, never the full path
    if (live.length >= 2) collisions.push({ file: path.join(path.basename(path.dirname(f)), path.basename(f)), name: path.basename(f), agents: live.map(([w]) => w), ts: iso(Math.max(...live.map(([, ts]) => ts))) });
  }
  collisions.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  const filesOf = (label) => { const seen = new Set(), out = []; for (const x of (touched.get(label) || []).sort((a, b) => b.ts - a.ts)) { const b = path.basename(x.f); if (!seen.has(b)) { seen.add(b); out.push(b); } if (out.length >= 8) break; } return out; };
  const toolView = (a) => {
    const p = a.tools.pend.filter((e) => ref - e.t < OPEN_MAX_MS), cur = p.length ? p[p.length - 1] : null;
    return { current_tool: cur ? { name: cur.name, summary: cur.summary, ts: iso(cur.t) } : null, recent_tools: a.tools.recent.slice(-15), open: p.length > 0 };
  };
  const used = new Set(); // transcript paths of agents seen, for cost totals
  const usageOf = (sid, aid) => {
    const p = trPath(sid, aid), t = p ? pump(p) : null;
    if (p) used.add(p);
    if (!t) return { model: null, have: false, usage: { ...zero(), usd_est: null } };
    let est = 0, any = false;
    for (const [m, u] of Object.entries(t.by)) { const v = usd(u, m); if (v !== null) { est += v; any = true; } }
    return { model: t.model, have: true, usage: { ...t.tot, usd_est: any ? Math.round(est * 1e6) / 1e6 : null } };
  };
  const stuckOf = (a, label, running, blocked) => {
    if (!running || a.wait || blocked) return null;
    const thr = thrMs(a.sid, a.aid) * (a.tools.pend.length ? 2 : 1), idle = ref - a.act;
    if (a.act && idle > thr) { alert(a.act + thr, 'stuck', label, `${label} has had no activity for ${Math.round(thr / 1000)}s`); mk(a.act + thr, 'stuck'); return Math.round(idle / 1000); }
    return null;
  };

  // project = the root of the directory tree a session worked in (deriveRoot over its cwdp counts);
  // sessions with no cwdp fall back to the modal cwd basename. Subagents share their parent session's sid, so they inherit its project
  const projOf = new Map();
  const pOf = (sid) => {
    let p = projOf.get(sid);
    if (!p) { p = projectInfo(sid, cwp.get(sid), cw.get(sid), C); projOf.set(sid, p); }
    return p;
  };
  const sessLive = (s) => !(s.ended || ref - s.last > SESSION_TTL_S * 1000);
  const subLive = (sub) => sub.done || !(ref - sub.last > STALE_SUB_S * 1000 || (sessions.get(sub.sid) || {}).ended); // an orphaned run is dropped rather than claimed running
  // state.projects order: first appearance of each project's sessions
  const rank = new Map();
  for (const s of sessions.values()) { const k = pOf(s.sid).key; if (!rank.has(k)) rank.set(k, rank.size); }
  const visible = new Map(); // project key -> info, for projects with agents in this view
  for (const s of sessions.values()) if (sessLive(s)) { const p = pOf(s.sid); visible.set(p.key, p); }
  for (const sub of subs.values()) if (subLive(sub)) { const p = pOf(sub.sid); visible.set(p.key, p); }
  const fin = finalNames(visible, rank);
  const PF = (p) => fin.get(p.key) || { name: p.alias || p.base, id: slug(p.alias || p.base) };

  const agents = [], tasks = [];
  for (const s of sessions.values()) {
    if (!sessLive(s)) continue;
    const running = s.active > 0 && ref - s.active < RUN_S * 1000; // turn open (prompt -> Stop), idle after 15 min of silence
    const tv = toolView(s), u = usageOf(s.sid, null), sf = stuckOf(s, s.id, running, subsRunning(s.sid)), p = pOf(s.sid), ek = errOf(s, ref, s.id);
    const ranMs = s.closed + (s.seg !== null ? Math.max(0, (running ? ref : s.last) - s.seg) : 0), ran = runS(ranMs);
    agents.push({ id: s.id, role: `orchestrator: Claude Code session${s.cwd ? ' in ' + s.cwd : ''}`, capabilities: ['claude-code'], can_delegate: true,
      status: ek ? 'errored' : running ? 'running' : 'idle', error_kind: ek, recent_failures: recentF(s, ref), current_task: null, last_event_at: iso(s.last),
      current_tool: tv.current_tool, recent_tools: tv.recent_tools, model: u.model, model_label: modelLabel(s.mdl) || modelLabel(u.model), usage: u.usage, files: filesOf(s.id),
      stuck: sf !== null, ...(sf !== null ? { stuck_for_s: sf } : {}), project: PF(p).name, project_id: PF(p).id,
      started_at: iso(s.first), ended_at: running ? null : iso(s.last), ran_s: ran, tok_per_min: tokPerMin(ran, u.usage, u.have) });
  }
  for (const sub of subs.values()) {
    if (!subLive(sub)) continue;
    const open = !sub.done, tv = toolView(sub), u = usageOf(sub.sid, sub.aid), sf = stuckOf(sub, sub.id, open, false), p = pOf(sub.sid);
    // a stopped/killed subagent never sends SubagentStop: once silent past the stuck threshold show it as stalled, not running
    const silent = open && sf !== null, running = open && !silent, ek = errOf(sub, ref, sub.id);
    // a killed subagent never stops: its open run segment ends at its last event; ran_s sums every run segment
    const ranMs = sub.ranMs + (sub.segOpen !== null ? Math.max(0, (silent ? sub.last : ref) - sub.segOpen) : 0), ran = runS(ranMs);
    agents.push({ id: sub.id, role: sub.role, capabilities: [], can_delegate: false, status: ek ? 'errored' : running ? 'running' : silent ? 'stalled' : 'idle', error_kind: ek, recent_failures: recentF(sub, ref),
      current_task: open ? 't-' + sub.id : null, last_event_at: iso(sub.last),
      current_tool: tv.current_tool, recent_tools: tv.recent_tools, model: u.model, model_label: modelLabel(sub.mdl) || modelLabel(u.model), usage: u.usage, files: filesOf(sub.id),
      stuck: sf !== null, ...(sf !== null ? { stuck_for_s: sf } : {}), project: PF(p).name, project_id: PF(p).id,
      started_at: iso(sub.start), ended_at: sub.done ? iso(sub.endMs) : silent ? iso(sub.last) : null, ran_s: ran, tok_per_min: tokPerMin(ran, u.usage, u.have) });
    tasks.push({ id: 't-' + sub.id, goal_id: GOAL_ID, title: sub.title, assignee: sub.id, status: sub.done && sub.failed ? 'failed' : running ? 'running' : silent ? 'stalled' : 'done',
      depends_on: [], attempts: 1, max_attempts: 1, inputs: {}, output_contract: 'n/a (observed)', acceptance: ['Observed'],
      artifacts: [], created_at: sub.ts, updated_at: iso(sub.last) });
  }
  for (const c of collisions) mk(Date.parse(c.ts), 'collision_active');

  // state.projects: one row per project with agents in this view
  const rankById = new Map();
  for (const [k, f] of fin) rankById.set(f.id, rank.get(k));
  const pg = new Map();
  for (const a of agents) {
    let g = pg.get(a.project_id);
    if (!g) { g = { id: a.project_id, name: a.project, agents: [], total: 0, running: 0, stalled: 0, errored: 0, last_event_at: a.last_event_at, ran_s_total: 0 }; pg.set(a.project_id, g); }
    g.agents.push(a.id); g.total++; g.ran_s_total += a.ran_s;
    if (a.status === 'running' || a.status === 'stalled' || a.status === 'errored') g[a.status]++;
    if (a.last_event_at > g.last_event_at) g.last_event_at = a.last_event_at;
  }
  const projects = [...pg.values()].sort((a, b) => rankById.get(a.id) - rankById.get(b.id));
  const labelName = new Map(); // agent label -> project display name, for alerts
  for (const s of sessions.values()) labelName.set(s.id, PF(pOf(s.sid)).name);
  for (const sub of subs.values()) labelName.set(sub.id, PF(pOf(sub.sid)).name);
  for (const a of alerts) a.project = labelName.get(a.agent) || 'unknown';

  // cost: totals across every transcript referenced by agents in this window (incl. finished ones)
  const by_model = Object.create(null), tot = zero(); // model ids come from transcripts: no prototype keys
  for (const p of used) { const t = p.startsWith('remote:') ? REMOTE.get(p) : TR.get(p); if (!t) continue; for (const [m, u] of Object.entries(t.by)) add(by_model[m] = by_model[m] || { ...zero(), _p: 1 }, u); }
  let total = 0, anyP = false;
  for (const [m, u] of Object.entries(by_model)) { delete u._p; add(tot, u); const v = usd(u, m); u.usd_est = v; if (v !== null) { total += v; anyP = true; } }
  const cost = { total_usd_est: anyP ? Math.round(total * 1e6) / 1e6 : null, tokens_total: tot.input + tot.output + tot.cache_read + tot.cache_write, by_model };

  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)); events.forEach((e, i) => { e.seq = i; });
  alerts.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { agents, tasks, events, alerts, collisions, cost, markers, projects };
}

function assemble(list, ref, replay) {
  const f = fold(list, ref);
  const newest = list.length ? list[list.length - 1].ts : null;
  const age = newest ? (ref - Date.parse(newest)) / 1000 : null;
  const liveness = age === null ? 'dead' : age < 1.5 * INTERVAL_S ? 'alive' : age < 3 * INTERVAL_S ? 'late' : 'dead';
  const first = list.length ? list[0].ts : new Date(ref).toISOString();
  const out = {
    goal: { id: GOAL_ID, title: 'Live Claude Code activity', description: 'Read-only view of Claude Code hook events.', status: 'active',
      success_criteria: [{ id: 'c1', text: 'Observing', met: false }], budget: { max_ticks: 1000000 },
      created_at: first, updated_at: newest || first },
    tasks: f.tasks, agents: f.agents, projects: f.projects,
    heartbeat: { seq: list.length, ts: newest, interval_s: INTERVAL_S, status: 'running', liveness, age_s: age === null ? null : Math.round(age * 10) / 10,
      last_tick_ms: 0, consecutive_errors: 0 },
    events: f.events.slice(-200),
    server_time: new Date(ref).toISOString(),
    mode: 'live',
    cost: f.cost, collisions: f.collisions, alerts: f.alerts.slice(-20),
  };
  if (replay) out.replay = true;
  return out;
}

let liveCache = { key: '', v: null };
function build() {
  ingest();
  const now = Date.now(), key = ingestSig + ':' + Math.floor(now / 1000);
  if (liveCache.key === key) return liveCache.v;
  const v = assemble(recs.slice(-FOLD_N), now, false);
  liveCache = { key, v };
  return v;
}
let atCache = { key: '', v: null };
function buildAt(atMs) {
  ingest();
  const key = ingestSig + ':' + atMs;
  if (atCache.key === key) return atCache.v;
  let end = recs.length; while (end > 0 && Date.parse(recs[end - 1].ts) > atMs) end--;
  const v = assemble(recs.slice(Math.max(0, end - FOLD_N), end), atMs, true);
  atCache = { key, v };
  return v;
}
let histCache = { key: '', v: null };
function history(limit) {
  ingest();
  const key = ingestSig + ':' + limit + ':' + Math.floor(Date.now() / 5000);
  if (histCache.key === key) return histCache.v;
  const list = recs, f = fold(list, Date.now());
  const seen = new Set(), ms = [];
  for (const m of f.markers.sort((a, b) => (a.ts < b.ts ? -1 : 1))) { const k = m.ts + m.type; if (m.type !== 'collision_active' && !seen.has(k)) { seen.add(k); ms.push(m); } }
  let out = ms;
  if (ms.length > limit) {
    const prio = ms.filter((m) => m.type === 'collision' || m.type === 'stuck' || m.type === 'session.start').slice(0, limit), rest = ms.filter((m) => !prio.includes(m));
    const room = Math.max(0, limit - prio.length), step = rest.length / Math.max(1, room), pick = [];
    for (let i = 0; i < room; i++) pick.push(rest[Math.floor(i * step)]);
    out = prio.concat(pick).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  }
  const v = { first_ts: list.length ? list[0].ts : null, last_ts: list.length ? list[list.length - 1].ts : null, count: list.length, markers: out };
  histCache = { key, v };
  return v;
}

// ---------- notifier (macOS osascript via execFile, args never shell-interpolated) ----------
const notifyStart = Date.now(), notified = new Set(), lastSent = new Map(), queue = [];
const NOTIFY_SCRIPT = 'on run argv\ndisplay notification (item 1 of argv) with title (item 2 of argv)\nend run';
const NOTIFY_SOUND_SCRIPT = 'on run argv\ndisplay notification (item 1 of argv) with title (item 2 of argv) sound name "Glass"\nend run';
// branded notifier (plugin/notify/aos-notify.mjs), loaded lazily once; null when absent or broken
const NOTIFY_MODULES = ['notify/aos-notify.mjs', 'plugin/notify/aos-notify.mjs'].map((r) => path.join(ROOT, r));
let notifierP = null;
function loadNotifier() {
  if (!notifierP) notifierP = (async () => {
    try {
      const file = process.env.AOS_NOTIFY_MODULE || NOTIFY_MODULES.find((f) => fs.existsSync(f));  // AOS_NOTIFY_MODULE: test-only override
      if (!file || !fs.existsSync(file)) return null;
      const mod = await import(pathToFileURL(file).href);
      return mod && typeof mod.notify === 'function' && typeof mod.formatNotification === 'function' ? mod : null;
    } catch { return null; }
  })();
  return notifierP;
}
// old path: osascript via execFile, args never shell-interpolated
function sendNotifyLegacy(kind, text, sound) {
  const title = 'AOS: ' + kind.replace('_', ' '), msg = String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 200);
  if (process.env.AOS_NOTIFY_DRY === '1') { console.log(`[notify:dry] ${kind} | ${msg}`); return; }
  try { execFile('osascript', ['-e', sound ? NOTIFY_SOUND_SCRIPT : NOTIFY_SCRIPT, msg, title], { timeout: 5000 }, () => {}); } catch {}
}
// a: the alert object (kind, text, agent, project); the branded notifier gets it whole, falling back to osascript on any failure
function sendNotify(a, sound) {
  const kind = String(a.kind), text = String(a.text);
  const opts = { kind, agent: a.agent, text, project: a.project && a.project !== 'unknown' ? a.project : undefined }; // display names only, never paths
  loadNotifier().then((mod) => {
    if (!mod) return sendNotifyLegacy(kind, text, sound);
    if (process.env.AOS_NOTIFY_DRY === '1') {
      const f = mod.formatNotification(opts);
      console.log(`[notify:dry] ${kind} | title=${JSON.stringify(f.title)} | subtitle=${JSON.stringify(f.subtitle)} | message=${JSON.stringify(f.message)}`);
      return;
    }
    return Promise.resolve(mod.notify({ ...opts, sound })).then((r) => { if (!r || !r.ok) sendNotifyLegacy(kind, text, sound); });
  }).catch(() => { try { sendNotifyLegacy(kind, text, sound); } catch {} });
}
function notifyTick() {
  try {
    const C = cfg().notify;
    if (!C.enabled) return;
    const st = build();
    for (const a of st.alerts) {
      const id = a.kind + '|' + a.agent + '|' + a.ts;
      if (notified.has(id)) continue;
      notified.add(id); if (notified.size > 2000) notified.delete(notified.values().next().value);
      if (Date.parse(a.ts) < notifyStart || !C.on.includes(a.kind)) continue;
      if (queue.length < 20) queue.push(a);
    }
    const now = Date.now();
    for (let i = 0; i < queue.length;) {
      const a = queue[i], last = lastSent.get(a.kind);
      if (last && last.text === a.text && now - last.t < 60000) { queue.splice(i, 1); continue; } // dedup identical
      if (last && now - last.t < 10000) { i++; continue; } // rate limit: 1 per 10s per kind
      lastSent.set(a.kind, { t: now, text: a.text }); queue.splice(i, 1);
      sendNotify(a, C.sound);
    }
  } catch {}
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function hostAllowed(req) {
  const ok = (h) => /^(127\.0\.0\.1|localhost)$/.test(h) || ALLOWED_HOSTS.has(h.toLowerCase());
  try {
    if (!ok(new URL('http://' + (req.headers.host || '')).hostname)) return false;
    if (req.headers.origin && !ok(new URL(req.headers.origin).hostname)) return false;
    return true;
  } catch { return false; }
}
function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, { error: 'bad path' }); }
  if (rel.includes('\0') || rel.includes('\\')) return send(res, 400, { error: 'bad path' });
  if (rel.split('/').some((s) => s.startsWith('.'))) return send(res, 404, { error: 'not found' });
  let file = path.resolve(UI, '.' + rel);
  if (file !== UI && !file.startsWith(UI + path.sep)) return send(res, 403, { error: 'forbidden' });
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    const real = fs.realpathSync(file);
    if (!real.startsWith(fs.realpathSync(UI) + path.sep)) return send(res, 403, { error: 'forbidden' });
    const stat = fs.statSync(real);
    res.writeHead(200, { ...HEADERS, 'Content-Type': MIME[path.extname(real).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
  } catch { send(res, 404, { error: 'not found' }); }
}

const server = http.createServer((req, res) => {
  try {
    if (!hostAllowed(req)) return send(res, 403, { error: 'forbidden host' });
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/api/state') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
      const at = new URL(req.url, 'http://localhost').searchParams.get('at');
      if (at) { const ms = Date.parse(at); if (!Number.isFinite(ms)) return send(res, 400, { error: 'bad at' }); return send(res, 200, buildAt(ms)); }
      return send(res, 200, build());
    }
    if (pathname === '/api/history') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
      const n = Number(new URL(req.url, 'http://localhost').searchParams.get('limit'));
      return send(res, 200, history(Number.isInteger(n) && n > 0 ? Math.min(n, 2000) : 200));
    }
    if (pathname === '/api/control') { req.resume(); return send(res, 405, { ok: false, error: 'monitor is read-only' }); }
    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    return serveStatic(req, res, pathname);
  } catch (e) { console.error(e); if (!res.headersSent) send(res, 500, { error: 'internal error' }); }
});
server.headersTimeout = 10000; server.requestTimeout = 15000;
server.listen(PORT, HOST, () => console.log(`AOS-1 live monitor on http://${HOST}:${PORT}  (read-only; ${FILE})`));
setInterval(notifyTick, 2000).unref();
const shutdown = () => { server.close(); setTimeout(() => process.exit(0), 200).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
