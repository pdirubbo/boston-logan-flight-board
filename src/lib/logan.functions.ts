import { createServerFn } from "@tanstack/react-start";

export const loadLogan = createServerFn({ method: "GET" })
  .validator((input: { apt?: string; fresh?: boolean } | undefined) => {
    void input?.apt;
    return { apt: "BOS" as const, fresh: Boolean(input?.fresh) };
  })
  .handler(async ({ data }) => {
    const { loadSnapshot } = await import("./logan.server");
    return loadSnapshot(data.apt, data.fresh);
  });

export const lookupInboundEdct = createServerFn({ method: "POST" })
  .validator((input: { fn: string; from: string; op?: string; arr?: string }) => {
    const fn = String(input?.fn ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8);
    const from = String(input?.from ?? "")
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 4);
    const op = String(input?.op ?? "").slice(0, 160);
    const arr = "BOS";
    if (!fn || from.length !== 3) throw new Error("Need a flight and a three-letter origin");
    return { fn, from, op, arr };
  })
  .handler(async ({ data }) => {
    const { inboundEdctFor } = await import("./logan.server");
    return inboundEdctFor(data.fn, data.from, data.op, data.arr);
  });

export const lookupAircraft = createServerFn({ method: "POST" })
  .validator((input: { tail?: string }) => {
    const tail = String(input?.tail ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8);
    if (tail.length < 4) throw new Error("Need a tail number");
    return { tail };
  })
  .handler(async ({ data }) => {
    const { aircraftFix } = await import("./logan.server");
    return aircraftFix(data.tail);
  });

export const resolveInbound = createServerFn({ method: "POST" })
  .validator((input: { fn: string; iso: string }) => {
    const fn = String(input?.fn ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8);
    const iso = String(input?.iso ?? "");
    if (!fn || Number.isNaN(Date.parse(iso))) throw new Error("Need a flight and a departure time");
    return { fn, iso };
  })
  .handler(async ({ data }) => {
    const { inboundForDeparture } = await import("./logan.server");
    return inboundForDeparture(data.fn, data.iso);
  });
