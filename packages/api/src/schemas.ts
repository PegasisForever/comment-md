import { z } from "zod";

export const anchorSchema = z.object({
  quote: z.string(),
  prefix: z.string(),
  suffix: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

export type Anchor = z.infer<typeof anchorSchema>;

export const authorSchema = z.enum(["Agent", "User"]);
export type Author = z.infer<typeof authorSchema>;

// note
export const noteCreateInput = z.object({
  markdown: z.string(),
  title: z.string(),
});

export const noteUpdateInput = z.object({
  noteId: z.string().min(1),
  markdown: z.string(),
  title: z.string(),
});

export const noteGetInput = z.object({
  noteId: z.string().min(1),
});

export const noteGetDiffInput = z.object({
  noteId: z.string().min(1),
});

// comment
export const commentListInput = z.object({
  noteId: z.string().min(1),
  includeResolved: z.boolean().optional().default(false),
});

export const commentCreateThreadInput = z.object({
  noteId: z.string().min(1),
  anchor: anchorSchema,
  body: z.string().min(1),
});

export const commentReplyInput = z.object({
  threadId: z.string().min(1),
  body: z.string().min(1),
  author: authorSchema,
});

export const commentResolveInput = z.object({
  threadId: z.string().min(1),
});

// outputs (typed shape used by clients)
export interface MessageDTO {
  id: string;
  author: Author;
  body: string;
  createdAt: string; // ISO
}

export interface ThreadDTO {
  id: string;
  resolved: boolean;
  anchor: Anchor;
  createdAt: string;
  updatedAt: string;
  messages: MessageDTO[];
}

export interface NoteGetOutput {
  noteId: string;
  title: string;
  versionId: string;
  markdown: string;
  html: string;
  threads: ThreadDTO[];
}

export interface NoteGetDiffOutput {
  previousMarkdown: string | null;
  latestMarkdown: string;
}
