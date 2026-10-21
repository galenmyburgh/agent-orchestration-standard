# Roadmap

## What exists

- **AOS-1 spec** (`SPEC.md`), JSON Schemas, a zero-dependency conformance validator with positive and negative fixtures, a reference server and a heartbeat runner with a simulated dispatcher.
- **Claude Code live dashboard** (the `aos-dashboard` plugin):
  - Hooks for 16 Claude Code events, written as sanitized one-line records to a local log.
  - A read-only monitor on `127.0.0.1:4318`: agents, subagents and projects (grouped by project root), per-agent model, tokens, run time and tok/min, tool feed, file-conflict detection, stuck / stalled / errored rules (per-model stuck thresholds), alerts, replay (`/api/state?at=`) and history markers.
  - Web UI (project graph, drawers, replay scrubber, cost readout, light/dark themes), terminal UI (`aos-dash`), a read-only MCP server (7 tools), an optional status line and a branded macOS notifier.
  - `make install` / `make doctor` / `make test`.

- **Hub** (`hub/`, `ship/`): one dashboard per person across several machines; a shipper on each machine, an
  ingest server with machine tokens, and the monitor in hub mode.

## Known limitations

- **Replay is approximate for tokens.** Replayed agent states, alerts and conflicts are rebuilt from the event log at the chosen time, but token totals come from the transcripts as they are now.
- **Bounded history.** The monitor keeps the newest 50,000 events in memory and reads only the current log file. The hook rotates the log at 5 MB into a single `hook-events.1.ndjson`, which is not re-read after a monitor restart.
- **New sessions only.** Plugin hook changes apply to sessions started after the change (or after `/reload-plugins`).
- **Notifications are macOS-only.** On other systems alerts still appear in the web UI, terminal view and MCP output; the notifier is skipped.
- **Desktop app sessions.** Hooks are verified in the CLI; whether every Claude Code surface fires plugin hooks has not been checked.
- **Dollar estimates** need per-model prices in `prices.json`, which ships empty on purpose.
- **Heuristics.** "Stuck" means silence beyond a threshold, so a long-thinking agent can be flagged; the thresholds are configurable per model family in `config.json`.

## Ideas

- Optional login item (launchd / systemd user unit) so the monitor survives reboots without a session starting it.
- Persist a compact history index so replay covers rotated logs.
- A control surface (approve / deny, autonomous goal runs), only with a hard spend cap and explicit approval rules, as SPEC section 7 requires.
- Alternative views, such as a knowledge-graph view of files and agents.
