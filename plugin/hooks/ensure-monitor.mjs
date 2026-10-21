#!/usr/bin/env node
// AOS dashboard autostart (SessionStart hook, registered async). Idempotent:
// starts the local monitor only if nothing answers on its port, and the hub shipper when <live>/ship.json exists
// (ship/aos-ship.mjs; it keeps a single instance itself). Binds nothing itself.
// Never writes to stdout, always exits 0. AOS_NO_AUTOSTART=1 disables it entirely.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(HERE, '..');
const DATA = process.env.CLAUDE_PLUGIN_DATA || '';
const LIVE = process.env.AOS_LIVE_DIR || (DATA ? path.join(DATA, 'live') : path.join(ROOT, 'live'));
const LOCK_DIR = DATA || path.dirname(LIVE);
const LOCK = path.join(LOCK_DIR, 'monitor-autostart.lock');
const DEFAULTS = path.join(ROOT, 'defaults');
const LOCK_STALE_MS = 15000;
const WAIT_MS = 3000;
const PROBE_MS = 500;
const PORT = (() => {
  const n = Number(process.env.AOS_PORT || process.env.PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 4318;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// True if anything answers GET /api/state on 127.0.0.1 within timeoutMs.
function alive(timeoutMs = PROBE_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/state', timeout: timeoutMs }, (res) => {
      res.resume();
      done(true);
    });
    req.on('timeout', () => { req.destroy(); done(false); });
    req.on('error', () => done(false));
    setTimeout(() => { req.destroy(); done(false); }, timeoutMs + 50).unref();
  });
}

async function waitForMonitor(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await alive()) return true;
    await sleep(150);
  }
  return false;
}

// Seed config.json / prices.json into the data dir once; never overwrite user edits.
function seedDefaults() {
  try {
    fs.mkdirSync(LIVE, { recursive: true });
    for (const f of ['config.json', 'prices.json']) {
      const src = path.join(DEFAULTS, f), dst = path.join(LIVE, f);
      try { fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL); } catch {}
    }
  } catch {}
}

// O_EXCL lock file; a lock older than LOCK_STALE_MS is taken over.
function acquireLock() {
  try { fs.mkdirSync(LOCK_DIR, { recursive: true }); } catch {}
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(LOCK); continue; }
      } catch { continue; }
      return false;
    }
  }
  return false;
}

function releaseLock() {
  try { fs.unlinkSync(LOCK); } catch {}
}

// Hub shipper: only when set up (aos-ship setup), and only if its pid file doesn't name a live process.
function ensureShipper() {
  try {
    const entry = path.join(ROOT, 'ship', 'aos-ship.mjs');
    if (!fs.existsSync(path.join(LIVE, 'ship.json')) || !fs.existsSync(entry)) return;
    const pid = Number(fs.existsSync(path.join(LIVE, 'ship.pid')) ? fs.readFileSync(path.join(LIVE, 'ship.pid'), 'utf8') : '');
    if (pid) { try { process.kill(pid, 0); return; } catch (e) { if (e.code === 'EPERM') return; } }
    const logFile = path.join(LIVE, 'ship.log');
    try { if (fs.statSync(logFile).size > 1024 * 1024) fs.truncateSync(logFile, 0); } catch {}
    const out = fs.openSync(logFile, 'a', 0o600);
    const child = spawn(process.execPath, [entry], { detached: true, stdio: ['ignore', out, out], env: { ...process.env, AOS_LIVE_DIR: LIVE } });
    child.on('error', () => {});
    child.unref();
    fs.closeSync(out);
  } catch {}
}

async function main() {
  if (process.env.AOS_NO_AUTOSTART === '1') return;
  seedDefaults(); // always seed first so the data dir has config/prices even when a monitor already answers
  ensureShipper();
  if (await alive()) return;
  if (!acquireLock()) { await waitForMonitor(WAIT_MS); return; } // another session is starting it
  try {
    if (await alive()) return; // started between our probe and the lock
    const entry = path.join(ROOT, 'monitor.mjs');
    if (!fs.existsSync(entry)) return;
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, AOS_LIVE_DIR: LIVE, PORT: String(PORT) },
    });
    child.on('error', () => {});
    child.unref();
    await waitForMonitor(WAIT_MS);
  } finally {
    releaseLock();
  }
}

main().catch(() => {}).finally(() => process.exit(0));
