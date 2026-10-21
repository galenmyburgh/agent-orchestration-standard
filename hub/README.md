# AOS hub: one dashboard across several machines

The plugin's monitor normally runs on the machine where Claude Code runs. With the hub, every machine ships its
activity to one server, and each person gets one dashboard covering all of their machines.

```
Mac A ─┐  hook log ─► ship/aos-ship.mjs ─ HTTPS POST /ingest (machine token) ─┐
Mac B ─┘                                                                       ▼
                                   hub/ingest.mjs ─► <data>/<person>/hook-events.ndjson ─► monitor.mjs (hub mode) ─► web UI
```

## What leaves a machine

The shipper sends the hook's already-sanitized records (see Privacy in `plugin/README.md`) with three changes:

- Folder paths become `/aos/p/<project>`, where the project is the nearest enclosing git repo (or the nearest folder
  with a project marker). Outside a project: `/aos/x/<folder>`.
- Edited file paths become `/aos/p/<project>/<path inside the project>` (still enough for cross-machine conflict
  detection), or `/aos/x/<folder>/<file>`.
- Transcript paths are removed. Instead, the shipper reads token counts and model ids from the local transcripts and
  sends them as `Usage` records. Transcript content never leaves the machine.

The hub re-validates every line against a field whitelist, drops anything else, and stamps the machine name from the
token (a machine can't claim to be another one). Sessions show up as `<machine>·<id>` in the dashboard.

## Server

```sh
AOS_HUB_DATA=/data node hub/ingest.mjs add-token <person> <machine>   # prints the token once; only its SHA-256 is kept
AOS_HUB_DATA=/data AOS_BIND=0.0.0.0 node hub/ingest.mjs               # POST /ingest, GET /health (port 4320)
AOS_LIVE_DIR=/data/<person> AOS_BIND=0.0.0.0 AOS_ALLOWED_HOSTS=<dashboard host> node monitor.mjs
```

- Put the monitors behind an authenticating proxy (for example Cloudflare Access). The monitor itself has no login;
  `AOS_ALLOWED_HOSTS` only adds the public hostname to its Host/Origin allow-list.
- Ingest limits: 1 MB and 2,000 lines per request, 4 KB per line, 120 requests per minute per token, timestamps
  within the last 30 days. The per-person log rotates at 32 MB (one old copy kept).
- `list-tokens` and `revoke <person> <machine>` manage tokens; the running ingest picks up changes immediately.
- Cost, measured: 50,000 events (several days of heavy use) take about 0.2 s of CPU to ingest; a monitor holding
  them uses about 90 MB of RAM and answers each 2-second dashboard poll in about 10 ms.

## Each machine

```sh
make install                                   # the plugin, as usual
make ship URL=https://<ingest host>/ingest      # paste the machine token when asked; saved in <data>/live/ship.json (0600)
make ship-status                               # running? last successful send? last error?
```

The shipper starts with every Claude Code session (single instance), sends new events every 2 seconds and usage
every 10 seconds, and catches up after being offline. By default it starts from the end of the local log; add
`--backfill` to `aos-ship setup` to send the existing history too. Its log is `<data>/live/ship.log`.
