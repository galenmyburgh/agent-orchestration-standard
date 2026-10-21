#!/usr/bin/env node
// Builds the aos-dashboard plugin from the repo sources. Zero dependencies. Idempotent.
//   node plugin/build.mjs
// Copies (into plugin/, never editing the originals):
//   ../monitor.mjs           -> monitor.mjs           (patched: data dir)
//   ../hooks/aos-hook.mjs    -> hooks/aos-hook.mjs    (patched: data dir)
//   ../ship/aos-ship.mjs     -> ship/aos-ship.mjs     (patched: data dir)
//   ../ui/                   -> ui/
//   ../cli/                  -> cli/                  (only if present)
// plugin/defaults/ (seeded config.json / prices.json) is tracked source and is not generated: live/ holds personal
// runtime data and is never copied into the plugin.
// plugin/mcp/ and the plugin's own manifests/hooks/skills are not touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const PLUGIN = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(PLUGIN, '..');
const EXCLUDE = new Set(['node_modules', 'live', '.DS_Store']);
const rows = []; // { file, bytes, action }

// Patch steps applied to the COPIES only. Each anchor must occur exactly once or the build fails.
// Effect: when AOS_LIVE_DIR is unset, the data dir is ${CLAUDE_PLUGIN_DATA}/live (persists across updates).
const PATCH_NOTE = '[build patch: plugin data dir]';
const PATCHES = {
  'hooks/aos-hook.mjs': {
    from: "const dir = process.env.AOS_LIVE_DIR || path.join(root, 'live');",
    to: `const dir = process.env.AOS_LIVE_DIR || (process.env.CLAUDE_PLUGIN_DATA ? path.join(process.env.CLAUDE_PLUGIN_DATA, 'live') : path.join(root, 'live')); // ${PATCH_NOTE}`,
  },
  'ship/aos-ship.mjs': {
    from: "const LIVE = process.env.AOS_LIVE_DIR || path.join(ROOT, 'live');",
    to: `const LIVE = process.env.AOS_LIVE_DIR || (process.env.CLAUDE_PLUGIN_DATA ? path.join(process.env.CLAUDE_PLUGIN_DATA, 'live') : path.join(ROOT, 'live')); // ${PATCH_NOTE}`,
  },
  'monitor.mjs': {
    from: "const LIVE = process.env.AOS_LIVE_DIR || path.join(ROOT, 'live');",
    to: `const LIVE = process.env.AOS_LIVE_DIR || (process.env.CLAUDE_PLUGIN_DATA ? path.join(process.env.CLAUDE_PLUGIN_DATA, 'live') : path.join(ROOT, 'live')); // ${PATCH_NOTE}`,
  },
};

function record(rel, bytes, action) { rows.push({ file: rel, bytes, action }); }

// Write dst only when its bytes differ; report whether anything changed.
function put(rel, content) {
  const dst = path.join(PLUGIN, rel);
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const same = fs.existsSync(dst) && Buffer.compare(fs.readFileSync(dst), buf) === 0;
  if (!same) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, buf); }
  return same ? 'unchanged' : 'written';
}

function listFiles(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.bak') || EXCLUDE.has(name)) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) listFiles(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out.sort();
}

// Copy a source directory into plugin/<rel>, pruning files that no longer exist in the source.
function syncDir(srcDir, rel) {
  const files = listFiles(srcDir);
  const keep = new Set();
  for (const f of files) {
    const relOut = path.posix.join(rel, f.split(path.sep).join('/'));
    keep.add(relOut);
    const content = fs.readFileSync(path.join(srcDir, f));
    record(relOut, content.length, put(relOut, content));
  }
  const dstDir = path.join(PLUGIN, rel);
  if (fs.existsSync(dstDir)) {
    for (const f of listFiles(dstDir)) {
      const relOut = path.posix.join(rel, f.split(path.sep).join('/'));
      if (!keep.has(relOut)) { fs.rmSync(path.join(PLUGIN, relOut)); record(relOut, 0, 'removed (stale)'); }
    }
  }
}

function copyPatched(srcRel, dstRel) {
  const text = fs.readFileSync(path.join(REPO, srcRel), 'utf8');
  const p = PATCHES[dstRel];
  let out = text;
  if (p) {
    const hits = text.split(p.from).length - 1;
    if (hits !== 1) throw new Error(`patch anchor for ${dstRel} found ${hits} times (expected 1); source changed, update build.mjs`);
    out = text.replace(p.from, () => p.to);
  }
  const action = put(dstRel, out);
  record(dstRel, Buffer.byteLength(out), p ? `${action} + patched` : action);
}

function fmtTable(list) {
  const w = Math.max(4, ...list.map((r) => r.file.length));
  const lines = [`${'FILE'.padEnd(w)}  ${'BYTES'.padStart(8)}  ACTION`];
  for (const r of list) lines.push(`${r.file.padEnd(w)}  ${String(r.bytes).padStart(8)}  ${r.action}`);
  const total = list.reduce((a, r) => a + r.bytes, 0);
  lines.push(`${'TOTAL'.padEnd(w)}  ${String(total).padStart(8)}  ${list.length} files`);
  return lines.join('\n');
}

function build() {
  // Monitor and hook: copied from the originals, with the data-dir patch.
  copyPatched('monitor.mjs', 'monitor.mjs');
  copyPatched('hooks/aos-hook.mjs', 'hooks/aos-hook.mjs');
  copyPatched('ship/aos-ship.mjs', 'ship/aos-ship.mjs');

  // UI (whole folder), and CLI if the other agent has created it.
  syncDir(path.join(REPO, 'ui'), 'ui');
  const cliSrc = path.join(REPO, 'cli');
  if (fs.existsSync(cliSrc) && fs.statSync(cliSrc).isDirectory()) syncDir(cliSrc, 'cli');
  else console.log('note: ../cli not present; plugin/cli not copied');

}

function validate() {
  const candidates = ['claude', path.join(os.homedir(), '.local', 'bin', 'claude')];
  for (const bin of candidates) {
    const r = spawnSync(bin, ['plugin', 'validate', './plugin'], { cwd: REPO, encoding: 'utf8', timeout: 60000 });
    if (r.error && r.error.code === 'ENOENT') continue;
    const out = `${r.stdout || ''}${r.stderr || ''}`.trimEnd();
    console.log(`\n$ ${bin} plugin validate ./plugin  (exit ${r.status}${r.signal ? `, signal ${r.signal}` : ''})`);
    console.log(out || '(no output)');
    return r.status === 0;
  }
  console.log('\nclaude CLI not found; validation skipped');
  return null;
}

build();
console.log(fmtTable(rows));
const ok = validate();
if (ok === false) process.exitCode = 1;
