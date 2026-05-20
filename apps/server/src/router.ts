import { router, publicProcedure, TRPCError } from "./trpc.js";
import { prisma } from "./db.js";
import { renderMarkdown } from "./markdown.js";
import {
  noteCreateInput,
  noteUpdateInput,
  noteGetInput,
  noteGetDiffInput,
  commentListInput,
  commentCreateThreadInput,
  commentReplyInput,
  commentResolveInput,
  type Anchor,
  type Author,
  type NoteGetOutput,
  type NoteGetDiffOutput,
  type ThreadDTO,
} from "@comment-md/api";

async function getLatestVersion(noteId: string) {
  return prisma.version.findFirst({
    where: { noteId },
    orderBy: { createdAt: "desc" },
  });
}

function toThreadDTO(thread: {
  id: string;
  resolved: boolean;
  quote: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
  createdAt: Date;
  updatedAt: Date;
  messages: {
    id: string;
    author: string;
    body: string;
    createdAt: Date;
  }[];
}): ThreadDTO {
  return {
    id: thread.id,
    resolved: thread.resolved,
    anchor: {
      quote: thread.quote,
      prefix: thread.prefix,
      suffix: thread.suffix,
      start: thread.start,
      end: thread.end,
    },
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
    messages: thread.messages.map((m) => ({
      id: m.id,
      author: (m.author === "Agent" ? "Agent" : "User") as Author,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

const noteRouter = router({
  create: publicProcedure
    .input(noteCreateInput)
    .mutation(async ({ input }) => {
      const note = await prisma.note.create({
        data: {
          title: input.title,
          versions: {
            create: {
              markdown: input.markdown,
            },
          },
        },
      });
      return { noteId: note.id };
    }),

  update: publicProcedure
    .input(noteUpdateInput)
    .mutation(async ({ input }) => {
      const existing = await prisma.note.findUnique({
        where: { id: input.noteId },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "note not found" });
      }
      await prisma.$transaction([
        prisma.note.update({
          where: { id: input.noteId },
          data: { title: input.title },
        }),
        prisma.version.create({
          data: {
            noteId: input.noteId,
            markdown: input.markdown,
          },
        }),
      ]);
      return;
    }),

  get: publicProcedure
    .input(noteGetInput)
    .query(async ({ input }): Promise<NoteGetOutput> => {
      const note = await prisma.note.findUnique({
        where: { id: input.noteId },
      });
      if (!note) {
        throw new TRPCError({ code: "NOT_FOUND", message: "note not found" });
      }
      const latest = await getLatestVersion(input.noteId);
      if (!latest) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "note has no versions",
        });
      }
      const threads = await prisma.thread.findMany({
        where: { versionId: latest.id },
        orderBy: { createdAt: "asc" },
        include: {
          messages: {
            orderBy: { createdAt: "asc" },
          },
        },
      });
      return {
        noteId: note.id,
        title: note.title,
        versionId: latest.id,
        markdown: latest.markdown,
        html: renderMarkdown(latest.markdown),
        threads: threads.map(toThreadDTO),
      };
    }),

  getDiff: publicProcedure
    .input(noteGetDiffInput)
    .query(async ({ input }): Promise<NoteGetDiffOutput> => {
      const versions = await prisma.version.findMany({
        where: { noteId: input.noteId },
        orderBy: { createdAt: "desc" },
        take: 2,
      });
      if (versions.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "note not found" });
      }
      return {
        latestMarkdown: versions[0]!.markdown,
        previousMarkdown: versions[1]?.markdown ?? null,
      };
    }),
});

const commentRouter = router({
  list: publicProcedure
    .input(commentListInput)
    .query(async ({ input }) => {
      const latest = await getLatestVersion(input.noteId);
      if (!latest) {
        throw new TRPCError({ code: "NOT_FOUND", message: "note not found" });
      }
      const threads = await prisma.thread.findMany({
        where: {
          versionId: latest.id,
          ...(input.includeResolved ? {} : { resolved: false }),
        },
        orderBy: { createdAt: "asc" },
        include: {
          messages: { orderBy: { createdAt: "asc" } },
        },
      });
      return threads.map(toThreadDTO);
    }),

  createThread: publicProcedure
    .input(commentCreateThreadInput)
    .mutation(async ({ input }) => {
      const latest = await getLatestVersion(input.noteId);
      if (!latest) {
        throw new TRPCError({ code: "NOT_FOUND", message: "note not found" });
      }
      const thread = await prisma.thread.create({
        data: {
          versionId: latest.id,
          quote: input.anchor.quote,
          prefix: input.anchor.prefix,
          suffix: input.anchor.suffix,
          start: input.anchor.start,
          end: input.anchor.end,
          messages: {
            create: {
              author: "User",
              body: input.body,
            },
          },
        },
        include: {
          messages: { orderBy: { createdAt: "asc" } },
        },
      });
      return toThreadDTO(thread);
    }),

  reply: publicProcedure
    .input(commentReplyInput)
    .mutation(async ({ input }) => {
      const thread = await prisma.thread.findUnique({
        where: { id: input.threadId },
        include: { version: true },
      });
      if (!thread) {
        throw new TRPCError({ code: "NOT_FOUND", message: "thread not found" });
      }
      const latest = await getLatestVersion(thread.version.noteId);
      if (!latest || latest.id !== thread.versionId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "thread not on latest version",
        });
      }
      const message = await prisma.message.create({
        data: {
          threadId: thread.id,
          author: input.author,
          body: input.body,
        },
      });
      await prisma.thread.update({
        where: { id: thread.id },
        data: { updatedAt: new Date() },
      });
      return {
        id: message.id,
        author: input.author,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
      };
    }),

  resolve: publicProcedure
    .input(commentResolveInput)
    .mutation(async ({ input }) => {
      const thread = await prisma.thread.findUnique({
        where: { id: input.threadId },
        include: { version: true },
      });
      if (!thread) {
        throw new TRPCError({ code: "NOT_FOUND", message: "thread not found" });
      }
      const latest = await getLatestVersion(thread.version.noteId);
      if (!latest || latest.id !== thread.versionId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "thread not on latest version",
        });
      }
      await prisma.thread.update({
        where: { id: thread.id },
        data: { resolved: true },
      });
      return;
    }),
});

export const appRouter = router({
  note: noteRouter,
  comment: commentRouter,
});

export type AppRouter = typeof appRouter;
