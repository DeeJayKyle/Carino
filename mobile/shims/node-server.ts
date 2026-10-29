// The phone app answers API calls in-process (mobile/engine.ts); there is no HTTP server.
export function serve() {
  throw new Error('No HTTP server in the mobile app');
}
export function serveStatic() {
  return async (_c: unknown, next: () => Promise<void>) => next();
}
