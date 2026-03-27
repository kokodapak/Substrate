# Changelog

## [0.2.0] — 2026-03-27

### New features

**Agent action surface**
- `POST /agent/actions` — agents can now log structured actions taken during remediation (restart_container, write_file, exec_command, http_request, custom). Ownership-enforced: only the agent that claimed the task can log actions against it.
- `GET /agent/tasks/:id/actions` — retrieve the full action log for a task, in chronological order.
- `GET /api/actions` — paginated action log across all tasks, filterable by agent_id, action_type, task_id, and time range.
- Each logged action appends an `action.logged` state event to the timeline.

**SSE task push channel**
- `GET /agent/stream` — agents can subscribe to a persistent SSE connection and receive `task.available` and `task.removed` events in real time. Eliminates the need to poll `/agent/next-action`.
- Heartbeat comment sent every 30 seconds to keep connections alive through proxies.
- `GET /agent/stream/status` — admin endpoint showing currently connected agents and connection count.
- The scanner and task complete/skip paths now emit SSE events after committing.

**Knowledge graph edges**
- The graph snapshot model now includes typed edges between nodes: `depends_on`, `exposes_port`, `mounts_volume`, `reads_env_file`.
- The scanner detects edges during the scan transaction: port bindings → `exposes_port`, volume mounts → `mounts_volume`, env values referencing scanned file paths → `reads_env_file`.
- `GET /api/graph` response includes an `edges` array.
- `GET /api/graph/diff` includes `edge_additions` and `edge_removals`.
- Rule evaluation context (`graphData`) now includes `edges`, allowing rules to reason about topology.
- New built-in rule: **docker-socket-exposed-via-volume** (severity: high) — fires when any container mounts `/var/run/docker.sock` via a volume, granting it full Docker daemon access.

**Multi-host federation**
- Register satellite Substrate instances with `POST /api/federation/satellites`. Satellite agent keys are stored AES-256-GCM encrypted.
- `POST /api/federation/sync/:id` triggers an immediate pull of graph, findings, and state from a satellite. Background sync runs every 60 seconds for all registered satellites.
- `GET /api/graph`, `GET /api/findings`, `GET /api/state`, `GET /api/timeline` now accept `?satellite_id=<id>` or `?satellite_id=all` to scope results across the federation.
- `GET /api/federation/satellites` shows satellite list with online/offline/error status.

**Plugin rule registry**
- `POST /api/rules/registry/export` — export all custom (non-built-in) rules as a portable JSON bundle.
- `POST /api/rules/registry/import` — import a rule bundle. Idempotent: existing rules are skipped, not overwritten. Returns `{ imported, skipped, errors }`.
- `POST /api/rules/registry/validate` — validate a rule object without persisting it. Returns `{ valid, errors }`.
- `GET /api/rules/registry/stats` — rule counts by type and enabled state.

**Dashboard**
- Federation screen: satellite management table, Add Satellite form, per-satellite Sync Now and Remove actions.
- Rule Registry screen: stats cards, export-to-file button, JSON file import with result display, inline rule validator.
- Live Feed panel on Overview: polls `/agent/stream/status` every 10 seconds and shows currently connected agents.
- Remediation page: task rows now expand to show the agent action log for claimed/completed tasks.

### Database migrations

This release adds four new migrations that run automatically on startup:

| File | Change |
|---|---|
| `0001_modern_zemo.sql` | Creates `agent_actions` table |
| `0002_little_pandemic.sql` | Creates `graph_edges` table |
| `0003_freezing_the_watchers.sql` | Creates `satellites` table; adds `satellite_id` column to `graph_snapshots`, `findings`, `tasks`, `state_events` |

Existing data is unaffected. All new columns are nullable with null meaning "local" (not from a satellite).

### Upgrading from 0.1.0

**Back up your database before updating.** Migrations cannot be reversed.

```bash
docker exec substrate sqlite3 /app/data/substrate.db ".backup /app/data/substrate.db.pre-0.2.0"
```

Then update:

```bash
git pull origin main
docker-compose down
docker-compose up -d --build
curl http://localhost:4000/health   # should show "version": "0.2.0"
```

No new environment variables are required.

---

## [0.1.0] — 2026-03-26

Initial release.

- System scanner (Docker containers + filesystem via `.botignore`/`.botinclude`)
- Knowledge graph with versioned snapshots and structural diff
- Rule engine (5 built-in rules, plugin rules via `plugins/rules/`)
- Agent task interface (claim, complete, skip with atomic SQLite transactions)
- State engine (event timeline, current state snapshot)
- React dashboard (Overview, Remediation, Access Control, Timeline, Settings)
- MCP server (7 tools)
- Deny-first access control
- Docker deployment with non-root user and HEALTHCHECK
