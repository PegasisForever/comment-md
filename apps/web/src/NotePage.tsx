import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { trpc } from "./trpc";
import type { Anchor, ThreadDTO } from "@comment-md/api";
import {
  buildAnchorFromSelection,
  flattenText,
  locateAnchor,
  rangesFromFlat,
  type DomRange,
} from "./anchor";
import { computeMarkdownDiff, computeLineDiff } from "./diff";
import { marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js/lib/common";

marked.use(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code: string, lang: string) {
      const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    },
  }),
);
marked.setOptions({ gfm: true, breaks: false });

const POLL_MS = 3000;

export function NotePage() {
  const { noteId } = useParams<{ noteId: string }>();
  if (!noteId) return null;

  const noteQuery = trpc.note.get.useQuery(
    { noteId },
    { refetchInterval: POLL_MS },
  );
  const utils = trpc.useUtils();

  const [diffMode, setDiffMode] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [selectionAnchor, setSelectionAnchor] = useState<Anchor | null>(null);
  const [selectionRect, setSelectionRect] = useState<DOMRect | null>(null);

  const previewRef = useRef<HTMLDivElement | null>(null);
  // Tracks the last (noteId, versionId) we've rendered so we can auto-enable
  // diff mode when polling brings in a new version of the same note.
  const lastSeenVersion = useRef<{ noteId: string; versionId: string } | null>(
    null,
  );

  const diffQuery = trpc.note.getDiff.useQuery(
    { noteId },
    {
      enabled: diffMode,
      refetchInterval: diffMode ? POLL_MS : false,
    },
  );

  const createThreadMut = trpc.comment.createThread.useMutation({
    onSuccess: () => utils.note.get.invalidate({ noteId }),
  });
  const replyMut = trpc.comment.reply.useMutation({
    onSuccess: () => utils.note.get.invalidate({ noteId }),
  });
  const resolveMut = trpc.comment.resolve.useMutation({
    onSuccess: () => utils.note.get.invalidate({ noteId }),
  });

  const note = noteQuery.data;
  const threads = note?.threads ?? [];
  const openThreads = threads.filter((t) => !t.resolved);
  const resolvedThreads = threads.filter((t) => t.resolved);

  // When the server returns a new versionId for the note currently in view
  // (e.g. the CLI just pushed an update), auto-enable diff mode so the user
  // sees what changed. Skips the very first observation per note so we don't
  // turn diff on the moment the page loads.
  useEffect(() => {
    if (!note?.noteId || !note?.versionId) return;
    const prev = lastSeenVersion.current;
    if (
      prev &&
      prev.noteId === note.noteId &&
      prev.versionId !== note.versionId
    ) {
      setDiffMode(true);
    }
    lastSeenVersion.current = {
      noteId: note.noteId,
      versionId: note.versionId,
    };
  }, [note?.noteId, note?.versionId]);

  const diffHtml = useMemo(() => {
    if (!diffMode) return null;
    if (!diffQuery.data) return null;
    const { previousMarkdown, latestMarkdown } = diffQuery.data;
    if (previousMarkdown === null) return null;
    return renderDiffHtml(previousMarkdown, latestMarkdown);
  }, [diffMode, diffQuery.data]);

  // Handle text selection. Works in both normal and diff modes. In diff
  // mode we project the anchor against latest-only content (skip .diff-del
  // text) so the stored anchor refers to text that exists in the latest
  // version.
  useEffect(() => {
    function onMouseUp(e: MouseEvent) {
      if (!previewRef.current) return;
      // Clicks inside the popover (textarea, buttons) collapse the document
      // selection — ignore them so the popover stays open while the user
      // types or submits.
      if (
        e.target instanceof Element &&
        e.target.closest(".selection-pop")
      ) {
        return;
      }
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setSelectionAnchor(null);
        setSelectionRect(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!previewRef.current.contains(range.commonAncestorContainer)) {
        setSelectionAnchor(null);
        setSelectionRect(null);
        return;
      }
      const anchor = buildAnchorFromSelection(
        previewRef.current,
        sel,
        diffMode ? ".diff-del" : undefined,
      );
      if (!anchor) {
        setSelectionAnchor(null);
        setSelectionRect(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      setSelectionAnchor(anchor);
      setSelectionRect(rect);
    }
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, [diffMode]);

  // Apply highlights to the preview. Runs in both normal and diff modes so
  // selecting a thread in the rail highlights its anchor regardless of view.
  // Resolved threads are only highlighted when active (selected in the rail).
  // While the new-comment popover is open, the pending selection is also
  // highlighted so the user can see what they're about to comment on after
  // focus leaves the document selection.
  // In diff mode the flat text excludes `.diff-del` content so anchors
  // (stored in latest-only coordinates) still locate correctly.
  useEffect(() => {
    if (!previewRef.current) return;
    const el = previewRef.current;
    clearHighlights(el);
    const exclude = diffMode ? ".diff-del" : undefined;
    const items: Array<{
      anchor: Anchor;
      threadId: string;
      active: boolean;
      resolved: boolean;
    }> = [];
    for (const t of openThreads) {
      items.push({
        anchor: t.anchor,
        threadId: t.id,
        active: activeThreadId === t.id,
        resolved: false,
      });
    }
    for (const t of resolvedThreads) {
      if (t.id !== activeThreadId) continue;
      items.push({
        anchor: t.anchor,
        threadId: t.id,
        active: true,
        resolved: true,
      });
    }
    if (selectionAnchor) {
      items.push({
        anchor: selectionAnchor,
        threadId: "__pending__",
        active: false,
        resolved: false,
      });
    }
    // Re-flatten between each pass so we never reference a text node that
    // was just split/removed by a previous applyHighlight.
    for (const item of items) {
      const flat = flattenText(el, exclude);
      const located = locateAnchor(flat, item.anchor);
      if (!located) continue;
      const ranges = rangesFromFlat(flat, located[0], located[1]);
      applyHighlight(ranges, item.threadId, item.active, item.resolved);
    }
  }, [openThreads, resolvedThreads, activeThreadId, note?.html, diffMode, diffHtml, selectionAnchor]);

  // Hook click on highlights → set active thread
  useEffect(() => {
    if (!previewRef.current) return;
    const el = previewRef.current;
    function onClick(e: Event) {
      const target = (e.target as HTMLElement).closest(".highlight");
      if (target instanceof HTMLElement && target.dataset.threadId) {
        setActiveThreadId(target.dataset.threadId);
      }
    }
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [note?.html]);

  const handleCreateThread = useCallback(
    async (body: string) => {
      if (!selectionAnchor) return;
      await createThreadMut.mutateAsync({
        noteId,
        anchor: selectionAnchor,
        body,
      });
      setSelectionAnchor(null);
      setSelectionRect(null);
      window.getSelection()?.removeAllRanges();
    },
    [createThreadMut, noteId, selectionAnchor],
  );

  const handleReply = useCallback(
    async (threadId: string, body: string) => {
      await replyMut.mutateAsync({
        threadId,
        body,
        author: "User",
      });
    },
    [replyMut],
  );

  const handleResolve = useCallback(
    async (threadId: string) => {
      // Capture the next open thread before mutating so we can advance the
      // selection after the resolve lands.
      const idx = openThreads.findIndex((t) => t.id === threadId);
      const next =
        idx >= 0
          ? openThreads[idx + 1] ?? openThreads[idx - 1] ?? null
          : null;
      await resolveMut.mutateAsync({ threadId });
      setActiveThreadId(next ? next.id : null);
    },
    [resolveMut, openThreads],
  );

  if (noteQuery.isLoading) {
    return <div className="loading">Loading…</div>;
  }
  if (noteQuery.error) {
    return (
      <div className="loading">
        Error: {noteQuery.error.message}
      </div>
    );
  }
  if (!note) return null;

  const headerTitle = note.title || note.noteId;

  const noPreviousVersion =
    diffMode && diffQuery.data && diffQuery.data.previousMarkdown === null;

  const showDiff = diffMode && !!diffHtml;
  const previewHtml = showDiff ? diffHtml! : note.html;

  return (
    <div className="app">
      <div className="topbar">
        <div>
          <h1>{headerTitle}</h1>
        </div>
        <div className="actions">
          <button
            type="button"
            className={`diff-toggle${diffMode ? " active" : ""}`}
            aria-pressed={diffMode}
            onClick={() => setDiffMode((v) => !v)}
          >
            Diff
          </button>
          <CopyRawButton markdown={note.markdown} />
        </div>
      </div>
      <div className="body">
        <div className="preview-wrap">
          {noPreviousVersion && (
            <div className="error-banner">
              No previous version — diff unavailable.
            </div>
          )}
          <div
            ref={previewRef}
            className={`preview${showDiff ? " diff-mode" : ""}`}
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
          {selectionAnchor && selectionRect && (
            <SelectionPopover
              rect={selectionRect}
              onSubmit={handleCreateThread}
              onCancel={() => {
                setSelectionAnchor(null);
                setSelectionRect(null);
              }}
              busy={createThreadMut.isPending}
            />
          )}
        </div>
        <div className="rail">
          {openThreads.length === 0 && resolvedThreads.length === 0 && (
            <div className="rail-empty">
              Select text in the preview to start a comment.
            </div>
          )}
          {openThreads.map((thread) => (
            <ThreadCard
              key={thread.id}
              thread={thread}
              active={activeThreadId === thread.id}
              onActivate={() => setActiveThreadId(thread.id)}
              onReply={(body) => handleReply(thread.id, body)}
              onResolve={() => handleResolve(thread.id)}
              busy={replyMut.isPending || resolveMut.isPending}
            />
          ))}
          {resolvedThreads.length > 0 && (
            <div className="resolved-section">
              <button
                className="resolved-toggle"
                onClick={() => setShowResolved((v) => !v)}
              >
                {showResolved ? "▼" : "▶"} Resolved ({resolvedThreads.length})
              </button>
              {showResolved &&
                resolvedThreads.map((thread) => (
                  <ThreadCard
                    key={thread.id}
                    thread={thread}
                    active={activeThreadId === thread.id}
                    onActivate={() => setActiveThreadId(thread.id)}
                    onReply={() => Promise.resolve()}
                    onResolve={() => Promise.resolve()}
                    busy={false}
                    readOnly
                  />
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function clearHighlights(root: HTMLElement) {
  const marks = root.querySelectorAll<HTMLElement>(".highlight");
  marks.forEach((m) => {
    const parent = m.parentNode!;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  });
}

function applyHighlight(
  ranges: DomRange[],
  threadId: string,
  active: boolean,
  resolved: boolean,
) {
  for (const r of ranges) {
    if (r.end <= r.start) continue;
    const node = r.node;
    const parent = node.parentNode;
    if (!parent) continue; // node was removed by a prior pass
    const text = node.nodeValue ?? "";
    const before = text.slice(0, r.start);
    const middle = text.slice(r.start, r.end);
    const after = text.slice(r.end);
    if (!middle) continue;
    const span = document.createElement("span");
    span.className =
      "highlight" +
      (active ? " active" : "") +
      (resolved ? " resolved" : "");
    span.dataset.threadId = threadId;
    span.textContent = middle;
    if (after) parent.insertBefore(document.createTextNode(after), node.nextSibling);
    parent.insertBefore(span, node.nextSibling);
    if (before) {
      node.nodeValue = before;
    } else {
      parent.removeChild(node);
    }
  }
}

function ThreadCard({
  thread,
  active,
  onActivate,
  onReply,
  onResolve,
  busy,
  readOnly,
}: {
  thread: ThreadDTO;
  active: boolean;
  onActivate: () => void;
  onReply: (body: string) => Promise<unknown>;
  onResolve: () => Promise<unknown>;
  busy: boolean;
  readOnly?: boolean;
}) {
  const [replyBody, setReplyBody] = useState("");
  const [showComposer, setShowComposer] = useState(false);

  const submitReply = async () => {
    const trimmed = replyBody.trim();
    if (!trimmed) return;
    await onReply(trimmed);
    setReplyBody("");
    setShowComposer(false);
  };

  return (
    <div
      className={`thread-card ${active ? "active" : ""} ${
        thread.resolved ? "resolved" : ""
      }`}
      onClick={onActivate}
    >
      <div className="thread-anchor">{thread.anchor.quote}</div>
      {thread.resolved && (
        <span className="thread-resolved-badge">Resolved</span>
      )}
      {thread.messages.map((m) => (
        <div className="thread-message" key={m.id}>
          <div className="thread-message-head">
            <span
              className={`author ${m.author === "Agent" ? "agent" : ""}`}
            >
              {m.author}
            </span>
          </div>
          <div className="thread-message-body">{m.body}</div>
        </div>
      ))}
      {!readOnly && !thread.resolved && (
        <>
          {showComposer ? (
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                submitReply();
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <textarea
                value={replyBody}
                onChange={(e) => setReplyBody(e.target.value)}
                onKeyDown={submitOnEnter}
                placeholder="Reply…"
                autoFocus
              />
              <ComposerHint action="reply" />
              <div className="composer-actions">
                <button
                  type="button"
                  onClick={() => {
                    setShowComposer(false);
                    setReplyBody("");
                  }}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="primary"
                  disabled={busy || !replyBody.trim()}
                >
                  Reply
                </button>
              </div>
            </form>
          ) : (
            <div className="thread-actions">
              <button onClick={() => setShowComposer(true)} disabled={busy}>
                Reply
              </button>
              <button onClick={onResolve} disabled={busy}>
                Resolve
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SelectionPopover({
  rect,
  onSubmit,
  onCancel,
  busy,
}: {
  rect: DOMRect;
  onSubmit: (body: string) => Promise<unknown>;
  onCancel: () => void;
  busy: boolean;
}) {
  const [body, setBody] = useState("");
  // Popover uses `position: fixed`, so coords are viewport-relative.
  const popWidth = 320;
  const popHeight = 150;
  const margin = 8;
  let top = rect.bottom + 6;
  if (top + popHeight > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - popHeight - 6);
  }
  const left = Math.min(
    window.innerWidth - popWidth - margin,
    Math.max(margin, rect.left),
  );
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = body.trim();
    if (!t || busy) return;
    await onSubmit(t);
    setBody("");
  };
  return (
    <form
      className="selection-pop"
      style={{ top, left }}
      onMouseDown={(e) => e.stopPropagation()}
      onSubmit={handleSubmit}
    >
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => submitOnEnter(e)}
        placeholder="Add a comment…"
        autoFocus
      />
      <ComposerHint action="comment" />
      <div className="composer-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="submit"
          className="primary"
          disabled={busy || !body.trim()}
        >
          Comment
        </button>
      </div>
    </form>
  );
}

function submitOnEnter(e: React.KeyboardEvent<HTMLTextAreaElement>) {
  if (
    e.key === "Enter" &&
    !e.shiftKey &&
    !e.nativeEvent.isComposing
  ) {
    e.preventDefault();
    e.currentTarget.form?.requestSubmit();
  }
}

function ComposerHint({ action }: { action: "comment" | "reply" }) {
  return (
    <div className="composer-hint">
      <kbd>Enter</kbd> to {action} · <kbd>Shift</kbd>+<kbd>Enter</kbd> for newline
    </div>
  );
}

function CopyRawButton({ markdown }: { markdown: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback for older browsers / non-secure contexts
      const ta = document.createElement("textarea");
      ta.value = markdown;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } finally {
        document.body.removeChild(ta);
      }
    }
  };
  return (
    <button onClick={onClick} className={copied ? "primary" : ""}>
      {copied ? "Copied" : "Copy raw"}
    </button>
  );
}

// renderDiffHtml: word-level inline diff for prose + line-level GitHub-style
// diff for fenced code blocks.
//
// Pipeline:
//   1. Replace every fenced code block in both markdowns with a unique
//      placeholder so diffWords doesn't try to diff source code as prose.
//   2. Word-diff the placeholdered markdowns, render through marked.
//   3. Substitute each placeholder paragraph in the resulting HTML with a
//      pre-rendered code-diff block. Pairs are matched by appearance index.
function renderDiffHtml(previous: string, latest: string): string {
  const { stripped: prevStripped, blocks: prevBlocks } =
    extractCodeBlocks(previous);
  const { stripped: latestStripped, blocks: latestBlocks } =
    extractCodeBlocks(latest);

  const parts = computeMarkdownDiff(prevStripped, latestStripped);
  let combined = "";
  let atLineStart = true;
  for (const p of parts) {
    if (p.added || p.removed) {
      const cls = p.added ? "diff-add" : "diff-del";
      const segments = splitDiffSegmentByLine(p.value, atLineStart);
      for (const seg of segments) {
        combined += seg.leading;
        if (seg.body) combined += wrapNonPlaceholders(seg.body, cls);
        combined += seg.trailing;
      }
    } else {
      combined += p.value;
    }
    atLineStart = p.value.endsWith("\n");
  }
  let html = marked.parse(combined, { async: false }) as string;

  // Substitute placeholders. They can appear as either a paragraph on
  // their own (most common) or inside a wrapping span (rare, when adjacent
  // to a diff word). Handle both.
  html = html.replace(
    /<p>(?:<span class="(?:diff-add|diff-del)">)?@@CMD_CODE_(\d+)@@(?:<\/span>)?<\/p>/g,
    (_match, idx) => renderCodeBlockDiff(prevBlocks, latestBlocks, Number(idx)),
  );
  html = html.replace(
    /@@CMD_CODE_(\d+)@@/g,
    (_m, idx) => renderCodeBlockDiff(prevBlocks, latestBlocks, Number(idx)),
  );
  return html;
}

function wrapNonPlaceholders(body: string, cls: string): string {
  // Split body by placeholders so we never wrap a placeholder in a diff
  // span — placeholders must be substituted as-is.
  const re = /@@CMD_CODE_\d+@@/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const before = body.slice(last, m.index);
    if (before) out += `<span class="${cls}">${before}</span>`;
    out += m[0];
    last = m.index + m[0].length;
  }
  const tail = body.slice(last);
  if (tail) out += `<span class="${cls}">${tail}</span>`;
  return out;
}

interface CodeBlock {
  lang: string;
  code: string;
}

function extractCodeBlocks(markdown: string): {
  stripped: string;
  blocks: CodeBlock[];
} {
  const blocks: CodeBlock[] = [];
  // Match ``` fences. Capture optional language token and body. Tolerate the
  // last fence not being followed by a newline.
  const stripped = markdown.replace(
    /```([^\n`]*)\n([\s\S]*?)\n```/g,
    (_match, lang: string, code: string) => {
      const idx = blocks.length;
      blocks.push({ lang: (lang || "").trim(), code });
      return `@@CMD_CODE_${idx}@@`;
    },
  );
  return { stripped, blocks };
}

function renderCodeBlockDiff(
  prevBlocks: CodeBlock[],
  latestBlocks: CodeBlock[],
  idx: number,
): string {
  const latest = latestBlocks[idx];
  const prev = prevBlocks[idx];
  if (!latest && !prev) return "";
  if (!latest && prev) {
    // Block exists only in previous — render as fully-removed.
    return renderCodeDiff(prev, { lang: prev.lang, code: "" });
  }
  if (!prev) return renderCodeDiff({ lang: latest!.lang, code: "" }, latest!);
  return renderCodeDiff(prev, latest!);
}

function renderCodeDiff(prev: CodeBlock, latest: CodeBlock): string {
  const lang = latest.lang || prev.lang || "";
  const langClass = lang ? ` language-${escapeHtml(lang)}` : "";
  const parts = computeLineDiff(prev.code, latest.code);
  // If both versions agree on every line, render this as a plain code block
  // so it's visually byte-identical to the non-diff view (no marker gutter,
  // no left-edge bar).
  if (parts.every((p) => !p.added && !p.removed)) {
    const highlighted = highlightLine(latest.code, lang);
    return `<pre><code class="hljs${langClass}">${highlighted}\n</code></pre>`;
  }
  let out = `<pre class="hljs code-diff"><code class="hljs${langClass}">`;
  for (const p of parts) {
    let lines = p.value.split("\n");
    // diffLines values end in '\n', so the split produces a trailing empty
    // element; drop it so we don't emit a phantom blank line.
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines = lines.slice(0, -1);
    }
    for (const line of lines) {
      const highlighted = highlightLine(line, lang);
      let cls = "code-diff-row";
      let marker = " ";
      if (p.added) {
        cls += " code-diff-add";
        marker = "+";
      } else if (p.removed) {
        cls += " code-diff-del";
        marker = "-";
      }
      out += `<span class="${cls}"><span class="code-diff-marker">${marker}</span>${highlighted}\n</span>`;
    }
  }
  out += "</code></pre>";
  return out;
}

function highlightLine(line: string, lang: string): string {
  if (!line) return "";
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(line, { language: lang, ignoreIllegals: true })
        .value;
    } catch {
      return escapeHtml(line);
    }
  }
  return escapeHtml(line);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

interface DiffSegment {
  leading: string;
  body: string;
  trailing: string;
}

// Split a diff part into per-line segments. For each line that starts at
// column 0 (either start of the part if `atLineStart`, or after a newline
// within the part), peel any markdown block prefix into `leading`.
function splitDiffSegmentByLine(value: string, atLineStart: boolean): DiffSegment[] {
  const out: DiffSegment[] = [];
  const lines = value.split(/(\n)/);
  let lineIsAtStart = atLineStart;
  let buffer: { leading: string; body: string; trailing: string } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const chunk = lines[i]!;
    if (chunk === "\n") {
      if (buffer) {
        buffer.trailing += "\n";
        out.push(buffer);
        buffer = null;
      } else {
        out.push({ leading: "\n", body: "", trailing: "" });
      }
      lineIsAtStart = true;
      continue;
    }
    if (chunk === "") continue;
    let leading = "";
    let body = chunk;
    if (lineIsAtStart) {
      const m = /^(\s*(?:#{1,6} |[-*+] |\d+\.\s|> )?)([\s\S]*)$/.exec(chunk);
      if (m) {
        leading = m[1] ?? "";
        body = m[2] ?? "";
      }
    }
    // strip trailing whitespace from body into trailing
    const m2 = /^([\s\S]*?)(\s*)$/.exec(body);
    let trailing = "";
    if (m2) {
      body = m2[1] ?? "";
      trailing = m2[2] ?? "";
    }
    buffer = { leading, body, trailing };
    lineIsAtStart = false;
  }
  if (buffer) out.push(buffer);
  return out;
}
