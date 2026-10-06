import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Plane, Radio, RefreshCw } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { LoganMap, type MapLeg } from "@/components/LoganMap";
import {
  BOS,
  airlineCode,
  hasClock,
  isNorthAmerica,
  type Arrival,
  type Flight,
  type FlightStatus,
  type Routing,
  type Snapshot,
} from "@/lib/flights";
import { loadLogan, lookupAircraft, lookupInboundEdct, resolveInbound } from "@/lib/logan.functions";

export const Route = createFileRoute("/")({
  loader: () => loadLogan({ data: { apt: "BOS" } }),
  component: Home,
});

type Tab = "dep" | "arr" | "lard";

function statusOf(st: Flight["st"] | "", detail: string): { kind: FlightStatus; label: string } {
  if (!st) return { kind: "Scheduled", label: "—" };
  return { kind: st, label: detail || st };
}

function inNext12(iso: string): boolean {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return false;
  const now = Date.now();
  return time >= now - 90 * 60_000 && time <= now + 12 * 3600_000;
}

function keepFuller(current: Snapshot, next: Snapshot): Snapshot {
  const currentCount = current.flights?.length ?? 0;
  const nextCount = next.flights?.length ?? 0;
  if (currentCount >= 40 && nextCount < currentCount * 0.65) {
    return { ...current, note: next.note || "Live feed was short, so the last full board is still up." };
  }
  return next;
}

function Home() {
  const initial = Route.useLoaderData();
  const refresh = useServerFn(loadLogan);
  const lookup = useServerFn(lookupInboundEdct);
  const locate = useServerFn(lookupAircraft);
  const linkTail = useServerFn(resolveInbound);
  const [data, setData] = useState<Snapshot>(initial);
  const [tab, setTab] = useState<Tab>("dep");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [airline, setAirline] = useState("");
  const [span, setSpan] = useState("");
  const [kind, setKind] = useState("");
  const [place, setPlace] = useState("");
  const [edctFirst, setEdctFirst] = useState(false);
  const [selected, setSelected] = useState("");
  const [craft, setCraft] = useState<{ lat: number; lon: number; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [edcts, setEdcts] = useState<Record<string, string>>(initial.edcts ?? {});
  const [checking, setChecking] = useState("");
  const [linking, setLinking] = useState("");
  const [linkNote, setLinkNote] = useState<Record<string, string>>({});
  const apt = "BOS" as const;
  const pulling = useRef(false);

  const dataRef = useRef(initial);
  dataRef.current = data;

  async function reload(fresh = false) {
    if (pulling.current) return;
    pulling.current = true;
    setBusy(true);
    try {
      const next = await refresh({ data: { apt: "BOS", fresh } });
      const chosen = keepFuller(dataRef.current, next);
      setData(chosen);
      if (chosen === next) setEdcts(next.edcts ?? {});
    } finally {
      pulling.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    const chosen = keepFuller(dataRef.current, initial);
    setData(chosen);
    if (chosen === initial) setEdcts(initial.edcts ?? {});
    setSelected("");
    setLinkNote({});
    setBusy(false);
  }, [initial]);

  useEffect(() => {
    const age = Date.now() - Date.parse(initial.pulled);
    const hasTurn = (initial.routings ?? []).some((row) => row.outbound);
    if (!hasTurn || age > 10 * 60_000) void reload();
    const timer = window.setInterval(() => void reload(), 10 * 60 * 1000);
    return () => window.clearInterval(timer);
    // The board reloads itself on a timer; the button calls reload directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flights = (data.flights ?? []).filter((flight) => inNext12(flight.iso));
  const arrivals = (data.arrivals ?? []).filter((row) => inNext12(row.iso));
  const routings = (data.routings ?? []).filter((row) => inNext12(row.outboundIso || row.inboundIso));

  const filteredFlights = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = flights.filter((flight) => {
      if (airline && carrierOf(flight.fn) !== airline) return false;
      if (!withinHours(flight.iso, span)) return false;
      if (kind && (flight.equip || "") !== kind) return false;
      if (place && flight.to !== place) return false;
      const clock = edcts[`${flight.inbound}|${flight.inboundFrom}`] ?? "";
      const blob = `${flight.t} ${flight.fn} ${flight.to} ${flight.city} ${flight.al} ${flight.tail} ${flight.gate} ${flight.inbound} ${flight.inboundFrom}`.toLowerCase();
      if (status === "Departed") return flight.st === "Departed" && (!q || blob.includes(q));
      if (flight.st === "Departed") return false;
      const kindOk = !status || flight.st === status || (status === "Inbound EDCT" && hasClock(clock));
      return (!q || blob.includes(q)) && kindOk;
    });
    if (edctFirst) {
      list = list
        .slice()
        .sort(
          (a, b) =>
            Number(hasClock(edcts[`${b.inbound}|${b.inboundFrom}`] ?? "")) -
              Number(hasClock(edcts[`${a.inbound}|${a.inboundFrom}`] ?? "")) || a.iso.localeCompare(b.iso),
        );
    }
    return list;
  }, [airline, edctFirst, edcts, flights, kind, place, query, span, status]);

  const filteredArrivals = useMemo(() => {
    const q = query.trim().toLowerCase();
    return arrivals.filter((row) => {
      if (airline && carrierOf(row.fn) !== airline) return false;
      if (!withinHours(row.iso, span)) return false;
      if (kind && (row.equip || "") !== kind) return false;
      if (place && row.from !== place) return false;
      const clock = edcts[`${row.fn}|${row.from}`] ?? "";
      const blob = `${row.t} ${row.fn} ${row.from} ${row.city} ${row.al} ${row.tail} ${row.gate}`.toLowerCase();
      const kindOk = !status || row.st === status || (status === "Inbound EDCT" && hasClock(clock));
      return (!q || blob.includes(q)) && kindOk;
    });
  }, [airline, arrivals, edcts, kind, place, query, span, status]);

  const filteredRoutings = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = routings.filter((row) => {
      const code = row.partner || carrierOf(row.outbound) || carrierOf(row.inbound);
      if (airline && code !== airline) return false;
      if (!withinHours(row.outboundIso || row.inboundIso, span)) return false;
      if (kind && (row.equip || "") !== kind) return false;
      if (place && (row.outboundTo || row.inboundFrom) !== place) return false;
      const clock = edcts[`${row.inbound}|${row.inboundFrom}`] ?? "";
      const blob = `${row.tail} ${row.inbound} ${row.inboundFrom} ${row.outbound} ${row.outboundTo} ${row.outboundCity} ${row.inboundGate} ${row.outboundGate}`.toLowerCase();
      if (status === "Departed") return row.outboundKind === "Departed" && (!q || blob.includes(q));
      if (row.outboundKind === "Departed") return false;
      const kindOk =
        !status ||
        row.outboundKind === status ||
        row.inboundKind === status ||
        (status === "Inbound EDCT" && hasClock(clock));
      return (!q || blob.includes(q)) && kindOk;
    });
    if (edctFirst) {
      list = list
        .slice()
        .sort(
          (a, b) =>
            Number(hasClock(edcts[`${b.inbound}|${b.inboundFrom}`] ?? "")) -
              Number(hasClock(edcts[`${a.inbound}|${a.inboundFrom}`] ?? "")) || a.sort.localeCompare(b.sort),
        );
    }
    return list;
  }, [airline, edctFirst, edcts, kind, place, query, routings, span, status]);

  const choices = useMemo(() => {
    const airlines = new Set<string>();
    const types = new Set<string>();
    const places = new Set<string>();
    if (tab === "arr") {
      for (const row of arrivals) {
        const code = carrierOf(row.fn);
        if (code) airlines.add(code);
        if (row.equip) types.add(row.equip);
        if (row.from) places.add(row.from);
      }
    } else if (tab === "lard") {
      for (const row of routings) {
        const code = row.partner || carrierOf(row.outbound) || carrierOf(row.inbound);
        if (code) airlines.add(code);
        if (row.equip) types.add(row.equip);
        const city = row.outboundTo || row.inboundFrom;
        if (city) places.add(city);
      }
    } else {
      for (const row of flights) {
        const code = carrierOf(row.fn);
        if (code) airlines.add(code);
        if (row.equip) types.add(row.equip);
        if (row.to) places.add(row.to);
      }
    }
    const sort = (values: Set<string>) => [...values].sort();
    return { airlines: sort(airlines), types: sort(types), places: sort(places) };
  }, [arrivals, flights, routings, tab]);

  const legs = useMemo<MapLeg[]>(() => {
    if (tab === "arr") {
      return filteredArrivals.map((row) => ({
        id: `arr|${row.fn}|${row.t}`,
        airport: row.from,
        into: true,
      }));
    }
    if (tab === "lard") {
      return filteredRoutings.flatMap((row) => {
        const drawn: MapLeg[] = [];
        if (row.inboundFrom) drawn.push({ id: `${row.id}|in`, airport: row.inboundFrom, into: true });
        if (row.outboundTo) drawn.push({ id: row.id, airport: row.outboundTo, into: false });
        return drawn;
      });
    }
    return filteredFlights.map((flight) => ({
      id: `${flight.fn}|${flight.t}`,
      airport: flight.to,
      into: false,
    }));
  }, [filteredArrivals, filteredFlights, filteredRoutings, tab]);

  const held = Object.values(edcts).filter(hasClock).length;
  const remaining = flights.filter((flight) => flight.st !== "Departed");
  const openRoutings = routings.filter((row) => row.outboundKind !== "Departed");
  const delayed = remaining.filter((flight) => flight.st === "Delayed").length;

  const pulled = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(data.pulled));

  async function rememberEdct(fn: string, from: string, op: string) {
    if (!fn || !isNorthAmerica(from)) return;
    const id = `${fn}|${from}`;
    const known = edcts[id];
    if ((known && known !== "FAA unavailable") || checking === id) return;
    setChecking(id);
    try {
      const value = await lookup({ data: { fn, from, op, arr: apt } });
      setEdcts((prev) => ({ ...prev, [id]: value || "None filed" }));
    } catch {
      setEdcts((prev) => ({ ...prev, [id]: "FAA unavailable" }));
    } finally {
      setChecking((currentId) => (currentId === id ? "" : currentId));
    }
  }

  async function choose(flight: Flight) {
    setSelected(`${flight.fn}|${flight.t}`);
    setCraft(null);
    if (flight.st === "Departed" && flight.tail) {
      void locate({ data: { tail: flight.tail } })
        .then((fix) => {
          if (!fix) return;
          setCraft({ lat: fix.lat, lon: fix.lon, label: `${flight.fn} ${flight.tail}${fix.alt ? ` · ${fix.alt}` : ""}` });
        })
        .catch(() => undefined);
    }
    if (flight.tail || flight.inbound) return;
    const id = `${flight.fn}|${flight.iso}`;
    setLinking(id);
    try {
      const turn = await linkTail({ data: { fn: flight.fn, iso: flight.iso } });
      setData((prev) => ({
        ...prev,
        flights: prev.flights.map((row) =>
          row.fn === flight.fn && row.iso === flight.iso && row.to === flight.to ? { ...row, ...turn } : row,
        ),
      }));
      if (!turn.tail && !turn.inbound) setLinkNote((prev) => ({ ...prev, [id]: "No tail filed" }));
    } catch {
      setLinkNote((prev) => ({ ...prev, [id]: "Try again" }));
    } finally {
      setLinking("");
    }
  }

  const title = tab === "arr" ? "Arrivals" : tab === "lard" ? "LARD" : "Departures";
  const blurb =
    tab === "lard"
      ? `One line per tail · ${openRoutings.length} still here · refreshes every 10 min`
      : tab === "arr"
        ? `Next 12 hours · ${arrivals.length} flights`
        : `Next 12 hours · ${remaining.length} still to depart`;

  return (
    <main className="flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden">
      <header className="flex flex-col gap-4 px-4 pt-4 pb-3 sm:flex-row sm:items-end sm:justify-between sm:px-6">
        <div>
          <p className="font-sans text-xs font-semibold tracking-[0.18em] text-navy uppercase">Boston Logan · KBOS</p>
          <h1 className="font-display text-4xl font-medium tracking-tight text-ink">{title}</h1>
          <p className="mt-1 flex items-center gap-2 text-sm text-mute">
            <span className="pulse-dot inline-block size-2 rounded-full bg-navy" />
            <span>
              {blurb} · pulled {pulled} ET
              {data.gdp ? ` · BOS GDP ${data.gdp.avg}` : ""}
              {data.note ? ` · ${data.note}` : ""}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Stat value={String(remaining.length)} label="departures" />
          <Stat value={String(delayed)} label="delayed" />
          <Stat value={String(held)} label="inbound EDCT" />
        </div>
      </header>
      <div className="grid flex-1 grid-cols-1 gap-3 px-3 pb-3 lg:min-h-0 lg:grid-cols-2 lg:overflow-hidden">
        <div className="h-80 overflow-hidden rounded-card border border-line bg-card lg:h-full">
          <LoganMap legs={legs} selected={selected} craft={craft} home={BOS} code="BOS" place="Boston" />
        </div>
        <section className="flex h-96 min-h-0 flex-col overflow-hidden rounded-card border border-line bg-card lg:h-full">
          <div className="flex flex-wrap gap-2 border-b border-line p-3">
            <div className="flex rounded-full border border-line bg-paper p-1" role="tablist" aria-label="Board">
              <TabButton active={tab === "dep"} onClick={() => { setCraft(null); setTab("dep"); }} label="Departures" count={remaining.length} />
              <TabButton active={tab === "arr"} onClick={() => { setCraft(null); setTab("arr"); }} label="Arrivals" count={arrivals.length} />
              <TabButton active={tab === "lard"} onClick={() => { setCraft(null); setTab("lard"); }} label="LARD" count={openRoutings.length} />
            </div>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="City, flight, tail"
              className="min-h-11 min-w-36 flex-1 rounded-full border border-line bg-paper px-4 text-sm text-ink outline-none"
            />
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="min-h-11 rounded-full border border-line bg-paper px-3 text-sm"
            >
              <option value="">All statuses</option>
              <option>On time</option>
              <option>Delayed</option>
              <option>Departed</option>
              <option>Landed</option>
              <option>Scheduled</option>
              <option>Cancelled</option>
              <option>Diverted</option>
              <option>Inbound EDCT</option>
            </select>
            <select aria-label="Airline" value={airline} onChange={(event) => setAirline(event.target.value)} className="min-h-11 rounded-full border border-line bg-paper px-3 text-sm">
              <option value="">All airlines</option>
              {choices.airlines.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
            <select aria-label="Time range" value={span} onChange={(event) => setSpan(event.target.value)} className="min-h-11 rounded-full border border-line bg-paper px-3 text-sm">
              <option value="">Any time</option>
              <option value="1">Next hour</option>
              <option value="3">Next 3 hours</option>
              <option value="6">Next 6 hours</option>
            </select>
            <select aria-label="Aircraft type" value={kind} onChange={(event) => setKind(event.target.value)} className="min-h-11 rounded-full border border-line bg-paper px-3 text-sm">
              <option value="">All aircraft</option>
              {choices.types.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
            <select aria-label={tab === "arr" ? "Origin" : "Destination"} value={place} onChange={(event) => setPlace(event.target.value)} className="min-h-11 rounded-full border border-line bg-paper px-3 text-sm">
              <option value="">{tab === "arr" ? "All origins" : "All destinations"}</option>
              {choices.places.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setEdctFirst((on) => !on)}
              className={`inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-semibold ${edctFirst ? "bg-rust text-paper" : "border border-navy bg-transparent text-navy"}`}
            >
              <Radio className="size-4" />
              {edctFirst ? "All flights" : "EDCT turns"}
            </button>
            <button
              type="button"
              onClick={() => void reload(true)}
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-navy px-4 text-sm font-semibold text-paper"
            >
              <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} />
              Pull now
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {tab === "dep" ? (
              <DepartureTable
                rows={filteredFlights}
                selected={selected}
                linking={linking}
                linkNote={linkNote}
                onChoose={choose}
              />
            ) : null}
            {tab === "arr" ? (
              <ArrivalTable
                rows={filteredArrivals}
                selected={selected}
                edcts={edcts}
                checking={checking}
                onChoose={(row) => {
                  const id = `arr|${row.fn}|${row.t}`;
                  setSelected(id);
                  setCraft(null);
                  void rememberEdct(row.fn, row.from, row.op);
                  const enroute = Boolean(row.tail) && row.st !== "Landed" && row.st !== "Cancelled" && row.st !== "Diverted" && (row.live || row.st === "Estimated");
                  if (!enroute) return;
                  void locate({ data: { tail: row.tail } }).then((fix) => {
                    if (!fix) return;
                    setCraft({ lat: fix.lat, lon: fix.lon, label: `${row.fn} ${row.tail}${fix.alt ? ` · ${fix.alt}` : ""}` });
                  }).catch(() => undefined);
                }}
              />
            ) : null}
            {tab === "lard" ? (
              <LardTable
                rows={filteredRoutings}
                flights={flights}
                arrivals={arrivals}
                selected={selected}
                edcts={edcts}
                checking={checking}
                onChoose={(row) => {
                  setSelected(row.id);
                  const match = flights.find((flight) => flight.fn === row.outbound && flight.inbound === row.inbound);
                  void rememberEdct(row.inbound, row.inboundFrom, match?.inboundOp ?? "");
                }}
              />
            ) : null}
          </div>
        </section>
      </div>
      <footer className="flex items-center gap-2 px-6 pb-4 text-xs text-mute">
        <Plane className="size-3.5" />
        Status is on time, delayed, departed, or landed. LARD is one line per tail. EDCTs load with the board, using the three-letter call sign.
      </footer>
    </main>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-semibold ${active ? "bg-navy text-paper" : "text-ink"}`}
    >
      {label}
      <span className={active ? "text-paper/80" : "text-mute"}>{count}</span>
    </button>
  );
}

function DepartureTable({
  rows,
  selected,
  linking,
  linkNote,
  onChoose,
}: {
  rows: Flight[];
  selected: string;
  linking: string;
  linkNote: Record<string, string>;
  onChoose: (flight: Flight) => void;
}) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="text-left text-xs tracking-wide text-mute uppercase">
          <Th>When</Th>
          <Th>Flight</Th>
          <Th>To</Th>
          <Th>Inbound</Th>
          <Th>Inbound ETA</Th>
          <Th>Status</Th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <Empty cols={6} />
        ) : (
          rows.map((flight) => {
            const key = `${flight.fn}|${flight.t}`;
            const kind = statusOf(flight.st, flight.detail);
            return (
              <tr
                key={flight.iso + flight.fn + flight.to}
                onClick={() => onChoose(flight)}
                className={`cursor-pointer border-t border-line ${selected === key ? "bg-paper" : ""}`}
              >
                <td className="px-3 py-2 whitespace-nowrap">
                  {flight.date} {flight.t}
                  <div className="text-xs text-mute">ETD {flight.etd || flight.t}</div>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <b>{flight.fn}</b>
                  <div className="text-xs text-mute">{flight.al}</div>
                </td>
                <td className="px-3 py-2">
                  <b>{flight.to}</b> {flight.city}
                  {flight.gate ? <div className="text-xs text-mute">Gate {flight.gate}</div> : null}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{inboundText(flight, linking, linkNote)}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <InboundEta flight={flight} />
                </td>
                <td className="px-3 py-2">
                  <span className={pillClass(kind.kind)}>{kind.label}</span>
                </td>
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}

function ArrivalTable({
  rows,
  selected,
  edcts,
  checking,
  onChoose,
}: {
  rows: Arrival[];
  selected: string;
  edcts: Record<string, string>;
  checking: string;
  onChoose: (row: Arrival) => void;
}) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="text-left text-xs tracking-wide text-mute uppercase">
          <Th>When</Th>
          <Th>Flight</Th>
          <Th>From</Th>
          <Th>Tail</Th>
          <Th>EDCT</Th>
          <Th>Status</Th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <Empty cols={6} />
        ) : (
          rows.map((row) => {
            const key = `arr|${row.fn}|${row.t}`;
            const kind = statusOf(row.st, row.detail);
            return (
              <tr
                key={row.iso + row.fn + row.from}
                onClick={() => onChoose(row)}
                className={`cursor-pointer border-t border-line ${selected === key ? "bg-paper" : ""}`}
              >
                <td className="px-3 py-2 whitespace-nowrap">
                  {row.date} {row.t}
                  <div className="text-xs text-mute">ETA {row.eta || row.t}</div>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <b>{row.fn}</b>
                  <div className="text-xs text-mute">{row.al}</div>
                </td>
                <td className="px-3 py-2">
                  <b>{row.from}</b> {row.city}
                  {row.gate ? <div className="text-xs text-mute">Gate {row.gate}</div> : null}
                </td>
                <td className="px-3 py-2 font-semibold whitespace-nowrap">{row.tail || "—"}</td>
                <td className="px-3 py-2 font-semibold whitespace-nowrap">{edctCell(row.fn, row.from, edcts, checking)}</td>
                <td className="px-3 py-2">
                  <span className={pillClass(kind.kind)}>{kind.label}</span>
                </td>
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}

function carrierOf(fn: string): string {
  const code = fn.toUpperCase().match(/^([A-Z0-9]{2})\d/)?.[1] ?? "";
  return code ? airlineCode(code) : "";
}

function withinHours(iso: string, hours: string): boolean {
  if (!hours) return true;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return false;
  const now = Date.now();
  return ms >= now - 20 * 60_000 && ms <= now + Number(hours) * 3_600_000;
}

function flightNo(fn: string) {
  const match = fn.toUpperCase().match(/^[A-Z0-9]{2}(\d+)$/);
  return match ? String(parseInt(match[1], 10)) : fn;
}

function partnerCode(row: Routing) {
  if (row.partner) return airlineCode(row.partner);
  const fn = row.outbound || row.inbound;
  const code = fn.toUpperCase().match(/^([A-Z0-9]{2})\d+$/)?.[1] ?? "";
  return code ? airlineCode(code) : "";
}

function AirlineMark({ code }: { code: string }) {
  const [failed, setFailed] = useState(false);
  if (!code) return null;
  if (failed) return <span className="font-semibold">{code}</span>;
  return (
    <img
      src={`https://pics.avs.io/120/36/${code}.png`}
      alt={code}
      title={code}
      width={72}
      height={22}
      referrerPolicy="no-referrer"
      className="h-5 w-12 object-contain object-left"
      onError={() => setFailed(true)}
    />
  );
}

function hhmm(value: string) {
  return value?.match(/(\d{2}:\d{2})/)?.[1] ?? "";
}

type LardKey = "in" | "org" | "toa" | "eta" | "tail" | "gate" | "out" | "dest" | "etd" | "airline";

function knownTimes(row: Routing, flights: Flight[], arrivals: Arrival[]) {
  const dep = flights.find((flight) => flight.fn === row.outbound && flight.to === row.outboundTo);
  const arr = arrivals.find((item) => item.fn === row.inbound && item.from === row.inboundFrom);
  const toa = row.toa || arr?.t || hhmm(row.inboundWhen);
  const eta = row.eta || arr?.eta || hhmm(row.inboundWhen) || toa;
  const etd = row.etd || dep?.etd || dep?.t || hhmm(row.outboundWhen);
  return { toa, eta, etd };
}

function lardValue(row: Routing, key: LardKey, flights: Flight[], arrivals: Arrival[]): string {
  const times = knownTimes(row, flights, arrivals);
  const gate = row.outboundGate || row.inboundGate;
  if (key === "in") return row.inbound ? flightNo(row.inbound) : "";
  if (key === "org") return row.inboundFrom;
  if (key === "toa") return times.toa;
  if (key === "eta") return times.eta;
  if (key === "tail") return row.tail;
  if (key === "gate") return gate;
  if (key === "out") return row.outbound ? flightNo(row.outbound) : "";
  if (key === "dest") return row.outboundTo;
  if (key === "etd") return times.etd;
  return partnerCode(row);
}

function LardTable({
  rows,
  flights,
  arrivals,
  selected,
  edcts,
  checking,
  onChoose,
}: {
  rows: Routing[];
  flights: Flight[];
  arrivals: Arrival[];
  selected: string;
  edcts: Record<string, string>;
  checking: string;
  onChoose: (row: Routing) => void;
}) {
  const [open, setOpen] = useState("");
  const [sortKey, setSortKey] = useState<LardKey>("etd");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const sorted = [...rows].sort((a, b) => {
    const cmp = lardValue(a, sortKey, flights, arrivals).localeCompare(lardValue(b, sortKey, flights, arrivals), undefined, {
      numeric: true,
    });
    return cmp * sortDir || a.sort.localeCompare(b.sort);
  });
  function sortBy(key: LardKey) {
    if (sortKey === key) setSortDir((dir) => (dir === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(1);
    }
  }
  const headers: [LardKey, string, string][] = [
    ["in", "Flight", "In"],
    ["org", "Org", ""],
    ["toa", "TOA", "Sched"],
    ["eta", "ETA", "Est"],
    ["tail", "Tail", ""],
    ["gate", "Gate", ""],
    ["out", "Flight", "Out"],
    ["dest", "Dest", ""],
    ["etd", "ETD", "Est"],
    ["airline", "AL", ""],
  ];
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="bg-navy text-left text-[11px] font-semibold tracking-wide text-white uppercase">
          <th className="w-8 px-2 py-2" />
          {headers.map(([key, label, hint]) => (
            <th key={key} className="px-2 py-2">
              <button type="button" onClick={() => sortBy(key)} className="inline-flex items-center gap-1 text-white">
                <span>
                  {label}
                  {hint ? <span className="mt-0.5 block text-[9px] font-medium tracking-normal normal-case opacity-75">{hint}</span> : null}
                </span>
                <span className="text-[10px] opacity-80">{sortKey === key ? (sortDir === 1 ? "↑" : "↓") : "↕"}</span>
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.length === 0 ? (
          <Empty cols={11} />
        ) : (
          sorted.map((row, index) => {
            const times = knownTimes(row, flights, arrivals);
            const gate =
              row.outboundGate && row.inboundGate && row.outboundGate !== row.inboundGate
                ? `${row.inboundGate}/${row.outboundGate}`
                : row.outboundGate || row.inboundGate;
            const expanded = open === row.id;
            return (
              <Fragment key={row.id}>
                <tr
                  onClick={() => onChoose(row)}
                  className={`cursor-pointer border-t border-[#e6e6e6] ${selected === row.id ? "bg-[#e7eef5]" : index % 2 ? "bg-[#f4f5f6]" : "bg-white"}`}
                >
                  <td className="px-2 py-1.5">
                    <button
                      type="button"
                      aria-label={expanded ? "Hide detail" : "Show detail"}
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpen(expanded ? "" : row.id);
                        onChoose(row);
                      }}
                      className="grid size-5 place-items-center rounded-full border border-navy text-xs leading-none text-navy"
                    >
                      {expanded ? "–" : "+"}
                    </button>
                  </td>
                  <td className="px-2 py-1.5 font-semibold whitespace-nowrap">{row.inbound ? flightNo(row.inbound) : ""}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{row.inboundFrom}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{times.toa}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{times.eta}</td>
                  <td className="px-2 py-1.5 font-semibold whitespace-nowrap">{row.tail}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{gate}</td>
                  <td className="px-2 py-1.5 font-semibold whitespace-nowrap">{row.outbound ? flightNo(row.outbound) : ""}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{row.outboundTo}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{times.etd}</td>
                  <td className="w-12 px-1 py-1.5 whitespace-nowrap">
                    <AirlineMark code={partnerCode(row)} />
                  </td>
                </tr>
                {expanded ? (
                  <tr className="bg-[#eef3f8] text-xs text-ink">
                    <td />
                    <td colSpan={10} className="px-2 py-2">
                      <span className="mr-4">Inbound {row.inbound || "—"} {row.inboundStatus || ""}</span>
                      <span className="mr-4">Outbound {row.outbound || "—"} {row.outboundStatus || ""}</span>
                      <span>EDCT {edctCell(row.inbound, row.inboundFrom, edcts, checking)}</span>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })
        )}
      </tbody>
    </table>
  );
}

function Th({ children }: { children: string }) {
  return <th className="sticky top-0 bg-card px-3 py-2 font-semibold">{children}</th>;
}

function Empty({ cols }: { cols: number }) {
  return (
    <tr>
      <td colSpan={cols} className="px-3 py-8 text-mute">
        No flights in this filter.
      </td>
    </tr>
  );
}

function inboundText(flight: Flight, linking: string, notes: Record<string, string>) {
  const id = `${flight.fn}|${flight.iso}`;
  if (linking === id) return "Checking";
  if (!flight.inbound && !flight.tail) return notes[id] || "—";
  return (
    <>
      <b>{flight.inbound || "—"}</b>
      <div className="text-xs text-mute">{flight.tail || "—"}</div>
    </>
  );
}

function InboundEta({ flight }: { flight: Flight }) {
  if (!flight.inbound) return "—";
  const time = hhmm(flight.inboundEta);
  if (!time) return "—";
  return (
    <>
      <b>{time}</b>
      {flight.inboundEtaKind ? <div className="text-xs text-mute">{flight.inboundEtaKind}</div> : null}
    </>
  );
}

function edctCell(fn: string, from: string, edcts: Record<string, string>, checking: string): string {
  if (!fn || !isNorthAmerica(from)) return "—";
  const id = `${fn}|${from}`;
  if (checking === id) return "Checking";
  return edcts[id] || "—";
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-24 rounded-card border border-line bg-card px-3 py-2">
      <b className="block font-display text-xl leading-none">{value}</b>
      <span className="text-xs tracking-wide text-mute uppercase">{label}</span>
    </div>
  );
}

function pillClass(kind: FlightStatus): string {
  const base = "inline-flex rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap";
  if (kind === "Cancelled" || kind === "Delayed" || kind === "Diverted" || kind === "Estimated") {
    return `${base} bg-rust/10 text-rust`;
  }
  if (kind === "Departed" || kind === "Landed" || kind === "On time" || kind === "Airborne") {
    return `${base} bg-navy/10 text-navy`;
  }
  return `${base} bg-line text-ink`;
}