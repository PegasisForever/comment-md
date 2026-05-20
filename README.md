# comment-md

Markdown notes with inline comments. CLI for agents, web UI for humans.

See [`spec.md`](spec.md) for the full specification and
[`decisions.md`](decisions.md) for implementation choices.

## Quick start

```bash
# install deps
bun install

# create the SQLite db
bunx prisma migrate deploy

# start the server (also serves the built web UI)
bun --cwd apps/web run build
bun --cwd apps/server run start

# create a note
COMMENT_MD_SERVER_URL=http://127.0.0.1:3210 \
  bun apps/cli/src/index.ts create ./your-file.md

# open the note in the browser
# http://127.0.0.1:3210/notes/<noteId>
```

## Layout

| Path | What |
|------|------|
| `apps/server` | Bun + tRPC + Prisma + markdown rendering + static SPA |
| `apps/web` | React + Vite SPA |
| `apps/cli` | Single-binary `comment-md` CLI |
| `packages/api` | Shared Zod inputs and tRPC `AppRouter` types |
| `prisma/` | Database schema and migrations |

## Development

```bash
# in two terminals:
bun --cwd apps/server run dev    # server on :3210
bun --cwd apps/web run dev       # Vite dev server on :5173 proxying /trpc
```

## Build the CLI binary

```bash
bun --cwd apps/cli run build
# produces apps/cli/dist/comment-md
```

## MCP server

The CLI doubles as a stdio MCP server. Run `comment-md mcp` (with
`COMMENT_MD_SERVER_URL` set) and it exposes five tools that mirror the CLI
commands: `create_note`, `update_note`, `list_comments`, `reply_to_thread`,
`resolve_thread`. Hook it into any MCP client (e.g. Claude Desktop):

```json
{
  "mcpServers": {
    "comment-md": {
      "command": "comment-md",
      "args": ["mcp"],
      "env": {
        "COMMENT_MD_SERVER_URL": "http://127.0.0.1:3210"
      }
    }
  }
}
```

## Docker

```bash
docker build -t pegasis0/comment-md .
docker run --rm -p 3210:3210 -v comment-md-data:/data pegasis0/comment-md
```

### Docker Compose

A [`docker-compose.yml`](./docker-compose.yml) is included:

```bash
docker compose up -d        # start (builds on first run)
docker compose logs -f      # tail logs
docker compose down         # stop
```

The compose file mounts a named volume `comment-md-data` at `/data` so the
SQLite database survives container restarts, exposes the server on
`http://127.0.0.1:3210`, and includes a `wget`-based `/healthz` healthcheck.

Point the CLI at the running container:

```bash
export COMMENT_MD_SERVER_URL=http://127.0.0.1:3210
comment-md create ./your-file.md
```

If the server sits behind a proxy with a public hostname, set
`COMMENT_MD_SHARE_BASE_URL` (uncomment it in `docker-compose.yml`) so the
CLI's `create`/`update` print share URLs that link to the proxy instead
of the localhost API URL.
