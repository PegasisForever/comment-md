# Implementation decisions

This document records ambiguities and judgment calls made while implementing
`spec.md`. Each entry cites the spec section it interprets.

## 1. Title derivation for `.md`-only filenames

**Spec excerpt** ([Domain model § Note](./spec.md#note)):
> If basename-without-extension is empty (e.g. file named `.md`), title is
> the empty string.

**Ambiguity:** the spec's example pseudo-code uses
`path.basename(filePath, path.extname(filePath))`. On Linux, that returns
`'.md'` (not `''`) when the file is named `.md`, because `path.extname('.md')`
returns `''` — leading-dot files are treated as having no extension by
Node/POSIX conventions.

**Decision:** implement the rule literally — split the basename at its
**last dot** rather than going through `extname`. If nothing precedes the
last dot, the title is the empty string. This honors the spec's example
behavior over the Node-stdlib default. Implemented in
[`apps/cli/src/index.ts`](apps/cli/src/index.ts) `deriveTitle`.

## 2. Diff rendering format

**Spec excerpt** ([Diff toggle](./spec.md#diff-toggle)):
> Format: **inline** — render previous vs latest with **deletions in red**
> and **additions in green** in the document flow (not side-by-side panes,
> not unified diff text).
> The client computes and renders the inline diff (server does not
> pre-render).

**Ambiguity:** "document flow" implies rendered markdown (not a raw word
diff), but the mechanics of overlaying word-level adds/deletes onto
markdown block structure are not specified.

**Decision:**
- Compute a **word-level diff** of the previous and latest markdown using
  the `diff` package's `diffWords`.
- Wrap each added/removed run in
  `<span class="diff-add">…</span>` / `<span class="diff-del">…</span>`
  *inline* in the combined markdown, then render through `marked`.
- To preserve markdown block structure, peel leading whitespace and any
  block-level prefix (`# `…`###### `, `- `, `* `, `+ `, `N. `, `> `) out of
  the span when the part begins at the start of a line. Without this,
  spans would swallow the `## ` of a heading or `- ` of a list item and
  break block parsing.
- Render code blocks with `highlight.js` (see decision 7) inside diff mode
  too.

Implemented in `renderDiffHtml` / `splitDiffSegmentByLine` in
[`apps/web/src/NotePage.tsx`](apps/web/src/NotePage.tsx).

## 3. Polling interval

**Spec excerpt** ([Web UI § Data loading](./spec.md#data-loading)):
> Poll `note.get` (e.g. 2–5s)…

**Decision:** poll every **3 seconds** (`POLL_MS = 3000`). Same interval for
the diff endpoint while diff mode is active.

## 4. Anchor model

**Spec excerpt** ([Domain model § Comment thread](./spec.md#comment-thread)):
> `anchor` (quote + prefix + suffix + start + end — same fuzzy model as
> upstream preview).

**Ambiguity:** there is no upstream codebase here, only the link reference.
We implemented an anchor model with the documented fields.

**Decision:** the anchor stores the exact selected `quote`, up to 32 chars
of `prefix` and `suffix` around it, plus the flat-text `start`/`end`
offsets at the time of selection. On re-render, locate by:
1. Try the exact `[start,end]` first.
2. Otherwise, find every occurrence of `quote` in the flat preview text;
   pick the one whose prefix+suffix best matches (with a small `start`
   distance tiebreaker).

Implemented in [`apps/web/src/anchor.ts`](apps/web/src/anchor.ts).

## 5. Selection popover position

The spec doesn't dictate where the new-comment composer appears. We position
it just below the selection's bounding rect. If the user clicks outside or
presses Cancel, the popover closes and the selection is cleared.

## 6. tRPC error mapping for stale writes

**Spec excerpt** ([API § comment](./spec.md#comment)):
> All write procedures verify the targeted note/thread is on the note's
> latest version (computed at request time) and return an error otherwise
> (e.g. "note has been updated" or "thread not on latest version").

**Decision:** raise `TRPCError({ code: 'BAD_REQUEST', message: 'thread not
on latest version' })` for stale `comment.reply` / `comment.resolve` and
`note has been updated` for stale thread creation paths. The CLI surfaces
the message verbatim on stderr with exit code 1.

## 7. Syntax highlighting (added requirement)

After the initial implementation, the user requested code syntax
highlighting on the frontend.

**Decision:** use `marked-highlight` + `highlight.js/lib/common` (~36
common languages) on **both**:
- the server's `renderMarkdown`, so the HTML returned by `note.get`
  arrives already highlighted (no flash of unstyled code), and
- the client's diff renderer, so the diff toggle keeps code colored.

Theme: GitHub light (`highlight.js/styles/github.css`).

This trades a one-shot ~150 KB gzipped JS payload (web bundle) for
consistent highlighting in both view modes. `sanitize-html` already allows
the `class` attribute on `span`/`code`/`pre`, so the `hljs-…` classes pass
through.

## 8. Sanitize-html allowlist

The server sanitizes rendered HTML. The allowlist includes the tags
emitted by `marked` (headings, lists, code, tables, blockquotes, GFM
checkboxes, etc.). External links get `target="_blank" rel="noopener
noreferrer"`. URL schemes are restricted to `http`, `https`, `mailto`.

## 9. Web UI under the same Bun server

Per the spec's deployment section the server serves the SPA in
production. The Bun fetch handler:
1. routes `/trpc/*` to `fetchRequestHandler`,
2. tries to serve a matching file from the configured `WEB_DIST` path,
3. falls back to `index.html` for SPA client-side routes (`/notes/:noteId`).

`WEB_DIST` is auto-detected from likely paths so the server works in dev,
in the monorepo, and inside the Docker image.

## 10. Database path

**Spec excerpt** ([Configuration § Server](./spec.md#server)):
> `DATABASE_URL` default: `file:./data/comment-md.db`

**Issue found:** Prisma resolves `file:` paths relative to
`schema.prisma`. With `./data/...` the SQLite file ends up at
`prisma/data/comment-md.db`. To make `data/` live at the project root as
the spec implies, the default in `.env` is `file:../data/comment-md.db`.
The runtime defaults match this and the Docker image overrides to
`file:/data/comment-md.db` (mounted volume).

## 11. No CLI-side schema dependency

The CLI talks to the server purely over the tRPC HTTP transport. It imports
only TypeScript **types** from `@comment-md/api` — no Zod, no Prisma, no
runtime tRPC server code — so `bun build --compile` produces a small,
self-contained binary that doesn't need `node_modules`.

## 12. `comment-md create` stdout

**Spec excerpt** ([CLI](./spec.md#cli-specification)):
> **`create` stdout:** **`noteId` only** — no JSON, no `versionId`.

**Decision:** stdout is the `noteId` followed by a single trailing
newline. (A bare `noteId` with no newline would not compose with shell
pipelines.)

## 13. `--include-resolved` formatting nuances

**Spec excerpt** ([CLI § list-comments](./spec.md#list-comments)):
> The literal token `[resolved]` appears only when the thread is
> resolved … for open threads, the brackets and word are omitted
> entirely.

**Decision:** the header line for an open thread is
`thread <id> anchor=<json-quote>`. For a resolved thread surfaced via
`--include-resolved` the form becomes
`thread <id> [resolved] anchor=<json-quote>` — there is a single space on
each side of `[resolved]`, never a double space.

## MCP server (reinstated)

The original spec dropped the MCP server. Reinstated after the initial
release as the `comment-md mcp` subcommand — running it starts an MCP
stdio server that exposes five tools:

- `create_note(markdown, title)`
- `update_note(noteId, markdown, title)`
- `list_comments(noteId, includeResolved?)`
- `reply_to_thread(threadId, body)` (always `Agent`)
- `resolve_thread(threadId)`

Each tool is a thin wrapper around the existing tRPC procedures the CLI
already calls, so there is no second API surface to keep in sync. The
SDK is dynamically imported only when the `mcp` subcommand runs, keeping
plain CLI invocations fast.

## 14. `create` / `update` stdout and share URL

`create` and `update` both print **two lines** on success:

```
<noteId>
<shareUrl>
```

`<shareUrl>` is `<base>/notes/<noteId>`, where `<base>` is:

1. `COMMENT_MD_SHARE_BASE_URL` if set, else
2. `COMMENT_MD_SERVER_URL` (always required).

Trailing slashes on the base are stripped.

**Rationale:** the original spec said `create` stdout was the `noteId` only.
That was good for shell composition but unhelpful when an agent wants to
surface a clickable share link. Always printing both lets callers pick the
field they want (`head -1` for id, `tail -1` for URL) without needing the
agent to know whether a share base is configured. `update` mirrors the same
output so agents can re-link to a note after pushing a new version.

The share-base env var is separate from the API server URL so the link the
agent surfaces can point at a public proxy / nicer hostname while the CLI
still talks to the local tRPC endpoint.

## 15. Out of scope confirmations

These features were considered and **not** implemented because the spec
puts them out of scope for v1:
- thread `reopen`, `editComment`, `deleteComment`, `deleteThread`
- WebSocket / CRDT collaboration
- full-text search, `note.list`
- mobile-optimized layout
- multi-server CLI config
- auth, share links, identity model
