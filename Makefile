# AOS: one-command setup for the Claude Code live dashboard.   Run `make` for the list of targets.
# Requires: Node 18+, the Claude Code CLI (`claude`), macOS for the branded notifier (everything else is portable).

SHELL      := /bin/bash
REPO       := $(CURDIR)
PLUGIN     := aos-dashboard@aos-local
MARKET     := aos-local
PORT       ?= 4318
DATA       := $(HOME)/.claude/plugins/data/aos-dashboard-aos-local
AOS        := node scripts/aos.mjs
ENSURE     := CLAUDE_PLUGIN_ROOT="$(REPO)/plugin" CLAUDE_PLUGIN_DATA="$(DATA)" AOS_PORT=$(PORT) node plugin/hooks/ensure-monitor.mjs

.DEFAULT_GOAL := help
.PHONY: help install uninstall build validate test doctor start stop restart open demo link unlink statusline statusline-off notifier screenshots ship ship-status ship-stop

help: ## Show this list
	@echo "AOS: Claude Code live dashboard"; echo
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*## "}{printf "  make %-16s %s\n", $$1, $$2}'
	@echo; echo "First time:  make install   then start a NEW Claude Code session and open http://127.0.0.1:$(PORT)"

install: check build validate ## Install everything: build, register + install the plugin, link `aos-dash`, build the notifier, start the monitor
	@echo "==> registering the local marketplace"
	@claude plugin marketplace add "$(REPO)" 2>&1 | tail -1 || true
	@echo "==> installing $(PLUGIN)"
	@claude plugin install $(PLUGIN) 2>&1 | tail -1 || true
	@$(MAKE) --no-print-directory link
	@$(MAKE) --no-print-directory notifier
	@$(MAKE) --no-print-directory start
	@echo; echo "Done. Next:"
	@echo "  1. Start a NEW Claude Code session (existing sessions keep their old hooks; or type /reload-plugins)"
	@echo "  2. Open http://127.0.0.1:$(PORT)   (or run: aos-dash)"
	@echo "  3. Optional status line:  make statusline"
	@echo "  4. Check everything:      make doctor"
	@echo "NOTE: if you previously added AOS hooks to ~/.claude/settings.json by hand, remove them (they would log every event twice)."

uninstall: stop unlink statusline-off ## Remove the plugin, marketplace entry, aos-dash link and status line (your data stays)
	-@claude plugin uninstall $(PLUGIN) 2>&1 | tail -1
	-@claude plugin marketplace remove $(MARKET) 2>&1 | tail -1
	@echo "Removed. Activity history is kept in $(DATA) (delete it to erase)."

check:
	@command -v node >/dev/null || { echo "node not found (need 18+)"; exit 1; }
	@node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' || { echo "node 18+ required"; exit 1; }
	@command -v claude >/dev/null || { echo "claude CLI not found: install Claude Code first"; exit 1; }

build: ## Regenerate plugin/ copies (monitor, hooks, ui, cli) from the sources
	@set -o pipefail; node plugin/build.mjs | tail -3

validate: ## Validate the plugin manifest with the Claude CLI
	@set -o pipefail; claude plugin validate ./plugin 2>&1 | tail -2

test: ## Run every test suite
	@set -o pipefail; echo "==> conformance"; node conformance/validate.mjs --selftest | tail -1
	@set -o pipefail; echo "==> terminal dashboard"; node cli/test.mjs | tail -1
	@set -o pipefail; echo "==> MCP server"; node plugin/mcp/test.mjs | tail -1
	@set -o pipefail; echo "==> hub (shipper -> ingest -> monitor)"; node hub/test.mjs | tail -1
	@set -o pipefail; echo "==> notifier"; node plugin/notify/test.mjs | tail -1
	@echo "==> theme contrast"; out="$$(node ui/theme-tokens.test.mjs)" || { echo "$$out"; exit 1; }; echo "$$out" | head -1
	@echo "==> orchestrator engine (fake claude)"; out="$$(node --test orchestrator/test/*.test.mjs 2>&1)" || { echo "$$out" | grep -E "^not ok|error:" | head -20; exit 1; }; echo "$$out" | grep -E '^# (pass|fail)' | tr '\n' ' '; echo

doctor: ## Check the whole setup and say what to fix
	@$(AOS) doctor

start: ## Start the live monitor (normally automatic when a session opens)
	@$(ENSURE); sleep 1; curl -s -o /dev/null -m 2 -w "monitor on :$(PORT): HTTP %{http_code}\n" http://127.0.0.1:$(PORT)/api/state || echo "monitor did not start: see make doctor"

stop: ## Stop the live monitor
	-@pkill -f "plugin/monitor.mjs" && echo "monitor stopped" || echo "monitor was not running"

restart: stop start ## Restart the monitor (needed after `make build` changes monitor.mjs)

open: ## Open the web dashboard
	@open http://127.0.0.1:$(PORT) 2>/dev/null || xdg-open http://127.0.0.1:$(PORT)

demo: ## Run the simulated AOS-1 demo (reference server) on :4317
	node server.mjs

link: ## Put `aos-dash` on your PATH (symlink in ~/.local/bin)
	@$(AOS) link

unlink: ## Remove the `aos-dash` link
	@$(AOS) unlink

statusline: ## (optional) Show an AOS summary in Claude Code's status line (edits ~/.claude/settings.json, with backup)
	@$(AOS) statusline

statusline-off: ## Remove the AOS status line
	@$(AOS) statusline-off

ship: ## Send this machine's activity to a central hub: make ship URL=https://<hub>/ingest (paste the machine token)
	@test -n "$(URL)" || { echo "usage: make ship URL=https://<hub>/ingest"; exit 1; }
	@AOS_LIVE_DIR="$(DATA)/live" node plugin/ship/aos-ship.mjs setup "$(URL)"
	@CLAUDE_PLUGIN_ROOT="$(REPO)/plugin" CLAUDE_PLUGIN_DATA="$(DATA)" AOS_NO_AUTOSTART= node plugin/hooks/ensure-monitor.mjs; sleep 1; AOS_LIVE_DIR="$(DATA)/live" node plugin/ship/aos-ship.mjs status

ship-status: ## Show whether the hub shipper is running and when it last sent
	@AOS_LIVE_DIR="$(DATA)/live" node plugin/ship/aos-ship.mjs status

ship-stop: ## Stop the hub shipper (it starts again with the next session while ship.json exists)
	@AOS_LIVE_DIR="$(DATA)/live" node plugin/ship/aos-ship.mjs stop

notifier: ## (macOS) Build the branded notification app
	@node plugin/notify/build-notifier.mjs 2>&1 | tail -2

screenshots: ## Regenerate docs/screenshots + docs/hero.gif from synthetic demo data (needs the monitor running, playwright-core; ffmpeg for the GIF)
	@node scripts/screenshots.mjs
