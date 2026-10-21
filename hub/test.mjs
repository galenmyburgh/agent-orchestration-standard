// End-to-end test: hook log -> ship/aos-ship.mjs -> hub/ingest.mjs -> monitor.mjs in hub mode. No network beyond 127.0.0.1.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, failN = 0;
const ok = (c, n) => { if (c) pass++; else { failN++; console.log('FAIL:', n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = () => 40000 + Math.floor(Math.random() * 20000);
const procs = [];
const start = (file, env) => { const p = spawn(process.execPath, [path.join(REPO, file)], { env: { ...process.env, ...env }, stdio: 'ignore' }); procs.push(p); return p; };
function req({ port: p, path: pathname, method = 'GET', host = '127.0.0.1', headers = {}, body }) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: p, path: pathname, method, headers: { Host: host, ...headers } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', () => resolve({ status: 0, body: '' }));
    if (body) r.write(body);
    r.end();
  });
}
async function until(f, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await sleep(150); } return null; }

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-hub-test-'));
try {
  const HUB = path.join(T, 'hub'), LIVE = path.join(T, 'live'), PROJ = path.join(T, 'work', 'my-repo');
  fs.mkdirSync(path.join(PROJ, '.git'), { recursive: true }); fs.mkdirSync(path.join(PROJ, 'src'), { recursive: true }); fs.mkdirSync(LIVE, { recursive: true });

  // transcripts: a main session and one subagent (counts only are read)
  const TP = path.join(T, 'transcripts', 'sess-1.jsonl'), SUB = path.join(T, 'transcripts', 'sess-1', 'subagents');
  fs.mkdirSync(SUB, { recursive: true });
  const u = (id, model, i, o) => JSON.stringify({ message: { id, model, usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: 'SECRET-CONTENT' } });
  fs.writeFileSync(TP, [u('m1', 'claude-opus-5-5', 100, 10), u('m1', 'claude-opus-5-5', 100, 10), u('m2', 'claude-opus-5-5', 50, 5)].join('\n') + '\n');
  fs.writeFileSync(path.join(SUB, 'agent-abc123.jsonl'), u('m3', 'claude-haiku-5-5', 7, 3) + '\n');

  const now = Date.now(), ts = (s) => new Date(now - 60000 + s * 1000).toISOString();
  const recs = [
    { ts: ts(0), ev: 'SessionStart', sid: 'aaaa1111', cwd: 'src', cwdp: path.join(PROJ, 'src'), tp: TP, m: 'claude-opus-5-5' },
    { ts: ts(1), ev: 'UserPromptSubmit', sid: 'aaaa1111', cwd: 'src', cwdp: path.join(PROJ, 'src') },
    { ts: ts(2), ev: 'PreToolUse', sid: 'aaaa1111', cwd: 'src', cwdp: path.join(PROJ, 'src'), tool: 'Edit', sum: 'a.js', f: path.join(PROJ, 'src', 'a.js') },
    { ts: ts(3), ev: 'PostToolUse', sid: 'aaaa1111', cwd: 'src', cwdp: path.join(PROJ, 'src'), tool: 'Edit', sum: 'a.js' },
  ];
  fs.writeFileSync(path.join(LIVE, 'hook-events.ndjson'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // hub ingest + a machine token
  const ingest = { port: port(), path: '/ingest' };
  const token = execFileSync(process.execPath, [path.join(REPO, 'hub/ingest.mjs'), 'add-token', 'person-a', 'mac-a'], { env: { ...process.env, AOS_HUB_DATA: HUB } }).toString().trim();
  ok(/^aos_[A-Za-z0-9_-]{43}$/.test(token), 'add-token prints a token');
  ok(!fs.readFileSync(path.join(HUB, 'tokens.json'), 'utf8').includes(token), 'tokens.json holds only the hash');
  start('hub/ingest.mjs', { AOS_HUB_DATA: HUB, PORT: String(ingest.port) });
  ok(await until(async () => (await req({ ...ingest, path: '/health' })).status === 200), 'ingest is up');

  ok((await req({ ...ingest, method: 'POST', headers: { Authorization: 'Bearer aos_' + 'x'.repeat(43) }, body: '{}' })).status === 401, 'unknown token -> 401');
  ok((await req({ ...ingest, headers: { Authorization: 'Bearer ' + token } })).status === 405, 'GET -> 405');
  const direct = await req({ ...ingest, method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: [
    JSON.stringify({ ts: ts(4), ev: 'Notification', sid: 'bbbb2222', cwdp: '/Users/someone/secret', tp: '/Users/someone/t.jsonl', host: 'spoofed', nt: 'permission_prompt' }),
    'not json', JSON.stringify({ ts: 'yesterday', ev: 'Stop' }),
  ].join('\n') });
  ok(direct.status === 200 && JSON.parse(direct.body).accepted === 1 && JSON.parse(direct.body).dropped === 2, 'bad lines dropped, good line kept');

  // shipper with backfill (sends the existing log)
  fs.writeFileSync(path.join(LIVE, 'ship.json'), JSON.stringify({ url: `http://127.0.0.1:${ingest.port}/ingest`, token, backfill: true }), { mode: 0o600 });
  const HUBLOG = path.join(HUB, 'person-a', 'hook-events.ndjson');
  start('ship/aos-ship.mjs', { AOS_LIVE_DIR: LIVE });
  const lines = await until(() => { try { const l = fs.readFileSync(HUBLOG, 'utf8').trim().split('\n').map((x) => JSON.parse(x)); return l.some((x) => x.ev === 'Usage' && x.agent_id) && l.length >= 6 ? l : null; } catch { return null; } });
  ok(lines, 'shipper delivered events and usage');
  if (lines) {
    const raw = fs.readFileSync(HUBLOG, 'utf8');
    ok(!raw.includes(T) && !raw.includes(os.homedir()) && !raw.includes('/Users/someone'), 'no local paths reach the hub');
    ok(!raw.includes('SECRET-CONTENT') && !raw.includes('"tp"'), 'no transcript content or paths reach the hub');
    ok(lines.every((l) => l.host === 'mac-a'), 'machine name comes from the token');
    ok(lines.find((l) => l.ev === 'SessionStart').cwdp === '/aos/p/my-repo', 'cwd mapped to its project');
    ok(lines.find((l) => l.ev === 'PreToolUse').f === '/aos/p/my-repo/src/a.js', 'edited file mapped inside its project');
    const main = lines.find((l) => l.ev === 'Usage' && !l.agent_id);
    ok(main && main.by['claude-opus-5-5'].input === 150 && main.by['claude-opus-5-5'].output === 15, 'session usage counted once per message');
    ok(lines.find((l) => l.ev === 'Usage' && l.agent_id === 'abc123').by['claude-haiku-5-5'].input === 7, 'subagent usage shipped');
  }

  // a new hook line is picked up live
  fs.appendFileSync(path.join(LIVE, 'hook-events.ndjson'), JSON.stringify({ ts: new Date().toISOString(), ev: 'Stop', sid: 'aaaa1111', cwdp: PROJ, tp: TP }) + '\n');
  ok(await until(() => fs.readFileSync(HUBLOG, 'utf8').includes('"ev":"Stop"')), 'new events follow within seconds');

  // the monitor in hub mode
  const mon = { port: port(), path: '/api/state' };
  start('monitor.mjs', { AOS_LIVE_DIR: path.join(HUB, 'person-a'), PORT: String(mon.port), AOS_ALLOWED_HOSTS: 'agents.example.com' });
  const st = await until(async () => { const r = await req({ ...mon, host: 'agents.example.com' }); return r.status === 200 ? JSON.parse(r.body) : null; });
  ok(st, 'monitor answers on its public hostname');
  ok((await req({ ...mon, host: 'evil.example.com' })).status === 403, 'other hostnames still refused');
  if (st) {
    const a = st.agents.find((x) => x.id.startsWith('mac-a·'));
    ok(a, 'session labelled with its machine');
    ok(a && a.project === 'my-repo', 'project name from the shipped path');
    ok(a && a.usage.input === 150 && a.model === 'claude-opus-5-5', 'tokens and model from shipped usage');
    ok(st.cost.tokens_total === 150 + 15, 'cost totals include shipped usage');
  }
} finally {
  for (const p of procs) try { p.kill(); } catch {}
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(`PASS ${pass} FAIL ${failN}`);
process.exit(failN ? 1 : 0);
