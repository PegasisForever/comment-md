#!/usr/bin/env bun
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@comment-md/api";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const VERSION = "0.1.1";

const USAGE = `comment-md — markdown notes with inline comments

usage:
  comment-md create <path>                            create a note from a file
  comment-md update <noteId> <path>                   create a new version
  comment-md list-comments <noteId> [--include-resolved]
  comment-md reply <threadId> "<body>"
  comment-md resolve <threadId>
  comment-md mcp                                       run an MCP server over stdio

env:
  COMMENT_MD_SERVER_URL=<url>      required, e.g. http://127.0.0.1:3210
  COMMENT_MD_SHARE_BASE_URL=<url>  optional. Base URL used to build the
                                   share link printed by 'create' and
                                   'update'. Falls back to
                                   COMMENT_MD_SERVER_URL when unset.

'create' and 'update' both print two lines on success:
  <noteId>
  <shareUrl>
`;

function die(msg: string, code = 1): never {
  process.stderr.write(msg.endsWith("\n") ? msg : msg + "\n");
  process.exit(code);
}

function getServerUrl(): string {
  const url = process.env.COMMENT_MD_SERVER_URL;
  if (!url) {
    die(
      "error: COMMENT_MD_SERVER_URL is not set. Example: COMMENT_MD_SERVER_URL=http://127.0.0.1:3210",
    );
  }
  return url.replace(/\/+$/, "");
}

function makeClient() {
  const url = getServerUrl();
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: url + "/trpc",
      }),
    ],
  });
}

function deriveTitle(path: string): string {
  // Per spec, the title is the basename without its extension. For files
  // like `.md` (where the entire basename IS the extension), the title is
  // the empty string. Node's path.basename keeps the original when the
  // result would be empty, so we replicate the strict rule explicitly.
  const base = basename(path);
  const lastDot = base.lastIndexOf(".");
  if (lastDot <= 0) {
    return lastDot === 0 ? "" : base;
  }
  return base.slice(0, lastDot);
}

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    die(`error: cannot read file ${path}: ${(e as Error).message}`);
  }
}

function shareBaseUrl(): string {
  const share = (process.env.COMMENT_MD_SHARE_BASE_URL ?? "").trim();
  if (share) return share.replace(/\/+$/, "");
  return getServerUrl();
}

function printIdAndUrl(noteId: string) {
  const url = `${shareBaseUrl()}/notes/${noteId}`;
  process.stdout.write(`${noteId}\n${url}\n`);
}

async function cmdCreate(path: string | undefined) {
  if (!path) die("error: 'create' requires <path>");
  const markdown = readFile(path!);
  const title = deriveTitle(path!);
  const client = makeClient();
  const res = await client.note.create.mutate({ markdown, title });
  printIdAndUrl(res.noteId);
}

async function cmdUpdate(noteId: string | undefined, path: string | undefined) {
  if (!noteId) die("error: 'update' requires <noteId> <path>");
  if (!path) die("error: 'update' requires <noteId> <path>");
  const markdown = readFile(path!);
  const title = deriveTitle(path!);
  const client = makeClient();
  await client.note.update.mutate({ noteId: noteId!, markdown, title });
  printIdAndUrl(noteId!);
}

async function cmdListComments(noteId: string | undefined, rest: string[]) {
  if (!noteId) die("error: 'list-comments' requires <noteId>");
  let includeResolved = false;
  for (const a of rest) {
    if (a === "--include-resolved") includeResolved = true;
    else die(`error: unknown flag ${a}`);
  }
  const client = makeClient();
  const threads = await client.comment.list.query({
    noteId: noteId!,
    includeResolved,
  });
  // Output format per spec.
  const lines: string[] = [];
  threads.forEach((thread, idx) => {
    const isResolved = thread.resolved;
    const resolvedToken = isResolved ? "[resolved] " : "";
    lines.push(
      `thread ${thread.id} ${resolvedToken}anchor=${JSON.stringify(thread.anchor.quote)}`,
    );
    for (const msg of thread.messages) {
      lines.push(
        `  ${msg.id} ${msg.author} ${toSecondPrecisionIso(msg.createdAt)} ${JSON.stringify(msg.body)}`,
      );
    }
    if (idx < threads.length - 1) lines.push("");
  });
  if (lines.length > 0) {
    process.stdout.write(lines.join("\n") + "\n");
  }
}

function toSecondPrecisionIso(iso: string): string {
  // Format: YYYY-MM-DDTHH:MM:SSZ
  // The DB stores as Date; toISOString gives ms precision. Strip ms.
  const d = new Date(iso);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
  );
}

async function cmdReply(threadId: string | undefined, body: string | undefined) {
  if (!threadId) die("error: 'reply' requires <threadId> <body>");
  if (body === undefined) die("error: 'reply' requires <threadId> <body>");
  const client = makeClient();
  await client.comment.reply.mutate({
    threadId: threadId!,
    body: body!,
    author: "Agent",
  });
}

async function cmdResolve(threadId: string | undefined) {
  if (!threadId) die("error: 'resolve' requires <threadId>");
  const client = makeClient();
  await client.comment.resolve.mutate({ threadId: threadId! });
}

async function cmdMcp() {
  // Validate config eagerly so the agent sees a clear failure on startup
  // rather than a cryptic error on the first tool call.
  getServerUrl();

  // Imports are dynamic so the MCP SDK is only loaded when actually needed.
  // bun's --compile bundles them either way; this keeps startup snappy for
  // the plain CLI commands.
  const { McpServer } = await import(
    "@modelcontextprotocol/sdk/server/mcp.js"
  );
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const { z } = await import("zod");

  const server = new McpServer({
    name: "comment-md",
    version: VERSION,
  });

  const textResult = (text: string) => ({
    content: [{ type: "text" as const, text }],
  });
  const errorResult = (err: unknown) => ({
    content: [
      {
        type: "text" as const,
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
      },
    ],
    isError: true,
  });

  server.tool(
    "create_note",
    "Create a new markdown note. Returns the noteId and a share URL the user can open in the comment-md web UI. Use this when the user wants to share a document for review.",
    {
      markdown: z
        .string()
        .describe("Full markdown content of the new note."),
      title: z
        .string()
        .describe(
          "Title shown in the web UI header. Pass an empty string to let the UI fall back to the noteId.",
        ),
    },
    async ({ markdown, title }) => {
      try {
        const client = makeClient();
        const res = await client.note.create.mutate({ markdown, title });
        const url = `${shareBaseUrl()}/notes/${res.noteId}`;
        return textResult(`noteId: ${res.noteId}\nurl: ${url}`);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.tool(
    "update_note",
    "Replace an existing note's content with a new version. The previous version is preserved on the server for diffs but its comments stop appearing in the open list. Use this when revising a shared document after feedback.",
    {
      noteId: z.string().describe("The note to update."),
      markdown: z.string().describe("New full markdown content."),
      title: z
        .string()
        .describe(
          "New title for the note. Pass an empty string to clear the title (the UI will fall back to the noteId).",
        ),
    },
    async ({ noteId, markdown, title }) => {
      try {
        const client = makeClient();
        await client.note.update.mutate({ noteId, markdown, title });
        const url = `${shareBaseUrl()}/notes/${noteId}`;
        return textResult(`noteId: ${noteId}\nurl: ${url}`);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.tool(
    "list_comments",
    "List comment threads on the latest version of a note. By default only open (unresolved) threads are returned. Threads on previous versions are not surfaced.",
    {
      noteId: z.string().describe("The note whose comments to list."),
      includeResolved: z
        .boolean()
        .optional()
        .describe(
          "When true, resolved threads are included alongside open ones.",
        ),
    },
    async ({ noteId, includeResolved }) => {
      try {
        const client = makeClient();
        const threads = await client.comment.list.query({
          noteId,
          includeResolved: includeResolved ?? false,
        });
        if (threads.length === 0) {
          return textResult("(no comments)");
        }
        const lines: string[] = [];
        threads.forEach((thread, idx) => {
          const tok = thread.resolved ? "[resolved] " : "";
          lines.push(
            `thread ${thread.id} ${tok}anchor=${JSON.stringify(thread.anchor.quote)}`,
          );
          for (const msg of thread.messages) {
            lines.push(
              `  ${msg.id} ${msg.author} ${toSecondPrecisionIso(msg.createdAt)} ${JSON.stringify(msg.body)}`,
            );
          }
          if (idx < threads.length - 1) lines.push("");
        });
        return textResult(lines.join("\n"));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.tool(
    "reply_to_thread",
    "Append a reply to an existing comment thread. The reply is recorded with author 'Agent'. The targeted thread must be on the note's latest version, otherwise this fails.",
    {
      threadId: z.string().describe("The thread to reply to."),
      body: z.string().describe("Reply text. Plain text; no markdown rendering."),
    },
    async ({ threadId, body }) => {
      try {
        const client = makeClient();
        await client.comment.reply.mutate({ threadId, body, author: "Agent" });
        return textResult(`replied to ${threadId}`);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.tool(
    "resolve_thread",
    "Mark a comment thread as resolved. Resolved threads disappear from the open list and are collapsed in the web UI. The thread must be on the latest version.",
    {
      threadId: z.string().describe("The thread to resolve."),
    },
    async ({ threadId }) => {
      try {
        const client = makeClient();
        await client.comment.resolve.mutate({ threadId });
        return textResult(`resolved ${threadId}`);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep the process alive until stdin closes. Bun keeps stdin readers
  // ref'd, so this resolves when the parent disconnects.
  await new Promise<void>((resolve) => {
    process.stdin.on("end", () => resolve());
    process.stdin.on("close", () => resolve());
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  try {
    switch (cmd) {
      case undefined:
      case "-h":
      case "--help":
      case "help":
        process.stdout.write(USAGE);
        return;
      case "create":
        await cmdCreate(argv[1]);
        return;
      case "update":
        await cmdUpdate(argv[1], argv[2]);
        return;
      case "list-comments":
        await cmdListComments(argv[1], argv.slice(2));
        return;
      case "reply":
        await cmdReply(argv[1], argv[2]);
        return;
      case "resolve":
        await cmdResolve(argv[1]);
        return;
      case "mcp":
        await cmdMcp();
        return;
      default:
        die(`error: unknown command '${cmd}'\n\n${USAGE}`);
    }
  } catch (err) {
    const e = err as { message?: string; data?: { code?: string } };
    const msg = e?.message ?? String(err);
    die(`error: ${msg}`);
  }
}

main();
