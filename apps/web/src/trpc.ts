import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@comment-md/api";

export const trpc = createTRPCReact<AppRouter>();
