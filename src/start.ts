import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

function sameBoard(origin: string, request: Request): boolean {
  try {
    if (origin === new URL(request.url).origin) return true;
  } catch {
    // The request URL can be the internal host. Fall through to the public host.
  }
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwarded) {
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
    if (origin === `${proto}://${forwarded}`) return true;
  }
  try {
    const host = new URL(origin).hostname;
    return (
      host === "grok-sandbox.com" ||
      host.endsWith(".grok-sandbox.com") ||
      host === "grok.me" ||
      host.endsWith(".grok.me")
    );
  } catch {
    return false;
  }
}

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
  secFetchSite: (site, ctx) => {
    if (site === "same-origin" || site === "none") return true;
    const origin = ctx.request.headers.get("origin");
    return !!origin && sameBoard(origin, ctx.request);
  },
  origin: (origin, ctx) => sameBoard(origin, ctx.request),
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
}));
