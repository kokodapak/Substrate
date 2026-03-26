# Substrate Deployment Guide

## Prerequisites

- Docker 20.10+
- docker-compose 1.29+ (or Docker Compose v2)
- Git
- Access to the host's Docker socket (`/var/run/docker.sock`)

---

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `SUBSTRATE_ADMIN_KEY` | Admin API key for privileged operations (scan, rules, state). Generate with `openssl rand -hex 32`. |
| `SUBSTRATE_AGENT_KEY` | Agent API key for AI agents claiming and completing tasks. Generate with `openssl rand -hex 32`. |
| `DATABASE_URL` | SQLite database path. Use `file:./data/substrate.db` for the default data volume. |
| `NODE_ENV` | Environment mode: `production`, `development`, or `test`. |
| `PORT` | HTTP port the server listens on (default: `4000`). |

### Optional

| Variable | Description |
|---|---|
| `DOCKER_SOCKET_PATH` | Path to Docker socket (default: `/var/run/docker.sock`). |
| `SENTRY_DSN` | Sentry DSN for error tracking. If absent, Sentry is disabled silently. |
| `SUBSTRATE_PLUGINS_DIR` | Absolute path to a directory containing plugin rule `.js` files (default: `plugins/rules` relative to cwd). |

---

## First Deployment

```bash
# 1. Clone the repository
git clone <repo-url> substrate
cd substrate

# 2. Copy the example environment file
cp .env.example .env

# 3. Fill in required values
#    Edit .env and set:
#      SUBSTRATE_ADMIN_KEY=<strong random key>
#      SUBSTRATE_AGENT_KEY=<strong random key>
#      DATABASE_URL=file:./data/substrate.db
#      NODE_ENV=production
#      PORT=4000

# 4. Create the data directory (persisted across container restarts)
mkdir -p data

# 5. Start the container
docker-compose up -d
```

---

## Verify

```bash
curl http://localhost:4000/health
```

Expected response:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime_s": 3,
  "db": "ok"
}
```

---

## Update (Blue-Green)

Substrate can be updated with zero downtime by building a new image and swapping the container:

```bash
# 1. Pull latest code
git pull origin main

# 2. Build the new image with a versioned tag
docker build -t substrate:new .

# 3. Stop and remove the old container
docker-compose down

# 4. Tag the new image as latest
docker tag substrate:new substrate:latest

# 5. Start the updated container
docker-compose up -d

# 6. Verify the new version is running
curl http://localhost:4000/health
```

For true zero-downtime in production, run a load balancer (e.g. Nginx or Caddy) in front of two Substrate instances on different ports and rotate traffic before stopping the old container.

---

## Rollback

```bash
# 1. Stop the current container
docker-compose down

# 2. Tag the previous image as the active one
#    (assumes you kept the previous image tagged, e.g. substrate:prev)
docker tag substrate:prev substrate:latest

# 3. Restart
docker-compose up -d

# 4. Verify
curl http://localhost:4000/health
```

To preserve rollback capability, tag the running image before every update:

```bash
docker tag substrate:latest substrate:prev
```

---

## Backup

The SQLite database is stored in the `./data/` volume mount. To back it up:

```bash
# Option 1: Copy the file directly (safe only when the container is stopped)
docker-compose stop
cp data/substrate.db data/substrate.db.bak
docker-compose start

# Option 2: Online backup using SQLite's backup API (safe while running)
docker exec <container-name> sqlite3 /app/data/substrate.db ".backup /app/data/substrate.db.bak"
```

To restore from backup:

```bash
docker-compose stop
cp data/substrate.db.bak data/substrate.db
docker-compose start
```

Schedule periodic backups with cron:

```bash
# Backup every day at 2 AM
0 2 * * * docker exec substrate sqlite3 /app/data/substrate.db ".backup /app/data/substrate.db.$(date +\%Y\%m\%d)"
```

---

## MCP Integration

Substrate ships with an MCP (Model Context Protocol) server entry point. This lets Claude Code, Cursor, or any MCP-compatible client use Substrate as a tool.

### Building the MCP entry point

The MCP server is compiled as part of the standard TypeScript build:

```bash
npm run build
# Output: dist/mcp/index.js
```

### Configuration for Claude Code

Add the following to your Claude Code MCP config (typically `~/.mcp.json`):

```json
{
  "mcpServers": {
    "substrate": {
      "command": "node",
      "args": ["/path/to/substrate/dist/mcp/index.js"],
      "env": {
        "SUBSTRATE_URL": "http://localhost:4000",
        "SUBSTRATE_ADMIN_KEY": "<your-admin-key>"
      }
    }
  }
}
```

### Configuration for Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "substrate": {
      "command": "node",
      "args": ["dist/mcp/index.js"],
      "env": {
        "SUBSTRATE_URL": "http://localhost:4000",
        "SUBSTRATE_ADMIN_KEY": "<your-admin-key>"
      }
    }
  }
}
```

### Available MCP tools

| Tool | Description |
|---|---|
| `substrate_scan` | Trigger an infrastructure scan |
| `substrate_get_graph` | Get the current infrastructure graph |
| `substrate_get_findings` | List security findings (optional: filter by severity/status) |
| `substrate_get_context` | Get agent context (service count, finding count, last scan) |
| `substrate_get_next_action` | Claim the next pending remediation task |
| `substrate_complete_task` | Mark a task as completed |
| `substrate_get_timeline` | Query the event timeline |

---

## Plugin Rules

To add custom detection rules, create `.js` files in the `plugins/rules/` directory (or the path set in `SUBSTRATE_PLUGINS_DIR`). Each file must export an array of rule objects:

```js
// plugins/rules/my-rules.js
module.exports = [
  {
    id: 'my-custom-rule',
    name: 'My Custom Rule',
    description: 'Detects something specific to our environment.',
    severity: 'high',
    condition_source: 'return graphData.services && graphData.services.some(s => s.name === "legacy-db");',
    recommended_action: 'Migrate away from the legacy database.',
  },
];
```

Plugin rules are loaded at startup and inserted into the database with `built_in = false`, making them fully mutable via the `/api/rules` API.
