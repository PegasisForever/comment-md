// Re-exports the server's AppRouter type for the clients.
// The actual router lives in apps/server. We use a relative path import
// here so this package can be used as a type-only bridge.
export type { AppRouter } from "../../../apps/server/src/router.js";
