import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  AIRPORTS,
  BOARDS,
  airlineCode,
  callsign,
  iataFlight,
  isNorthAmerica,
  type Arrival,
  type Flight,
  type Program,
  type Routing,
  type Snapshot,
} from "./flights.ts";

const UA = "Mozilla/5.0 LoganBoard/1.0";
const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const PRIVATE = ["executive jet", "netjets", "wheels up", "vista", "flexjet", "xojet", "flyexclusive", "planesense"];
const CACHE_VERSION = 19;
type BoardCode = "BOS";

type Turn = Pick<
  Flight,
  "inbound" | "inboundFrom" | "inboundEta" | "inboundEtaKind" | "inboundGate" | "inboundStatus" | "inboundOp" | "tail"
>;

type Leg = {
  fn: string;
  callsign: string;
  al: string;
  op: string;
  tail: string;
  gate: string;
  other: string;
  city: string;
  sched: number;
  est: number;
  real: number;
  event: number;
  phase: "sched" | "eta" | "landed";
  equip: string;
  st: Flight["st"];
  detail: string;
};

type RawFlight = {
  identification?: {
    number?: { default?: string | null };
    callsign?: string | null;
    codeshare?: string[] | null;
  };
  status?: { live?: boolean; text?: string; icon?: string | null; generic?: { status?: { text?: string } } };
  aircraft?: { registration?: string | null; model?: { code?: string | null; text?: string | null } | null };
  owner?: { name?: string | null };
  airline?: { name?: string | null; code?: { iata?: string | null } };
  airport?: { origin?: AirportSide; destination?: AirportSide };
  time?: {
    scheduled?: { departure?: number | null; arrival?: number | null };
    real?: { departure?: number | null; arrival?: number | null };
    estimated?: { departure?: number | null; arrival?: number | null };
    other?: { eta?: number | null };
  };
};

type AirportSide = {
  code?: { iata?: string | null };
  name?: string | null;
  info?: { gate?: string | null; terminal?: string | null };
  position?: { region?: { city?: string | null } };
};

type FsRow = {
  sortTime?: string;
  operatedBy?: string;
  carrier?: { fs?: string; flightNumber?: string; name?: string };
  airport?: { fs?: string; city?: string };
};

let caches = new Map<BoardCode, { at: number; v: number; data: Snapshot }>();
const edctCache = new Map<string, { at: number; value: string }>();
const turnCache = new Map<string, { at: number; value: Turn }>();
const MIN_BOARD = 80;

const EMPTY: Turn = {
  inbound: "",
  inboundFrom: "",
  inboundEta: "",
  inboundEtaKind: "",
  inboundGate: "",
  inboundStatus: "",
  inboundOp: "",
  tail: "",
};

async function getText(url: string, ua = UA, ms = 12000, referer = "https://www.flightradar24.com/"): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": ua, Accept: "application/json,text/html,text/xml,*/*", Referer: referer },
    signal: AbortSignal.timeout(ms),
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.text();
}

const fixes = new Map<string, { at: number; value: { lat: number; lon: number; alt: string; track: number } | null }>();

export async function aircraftFix(tail: string): Promise<{ lat: number; lon: number; alt: string; track: number } | null> {
  const key = tail.toUpperCase();
  const hit = fixes.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  let value: { lat: number; lon: number; alt: string; track: number } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const text = await getText(`https://api.adsb.lol/v2/reg/${encodeURIComponent(key)}`, BROWSER, 8000, "https://adsb.lol/");
      const parsed = JSON.parse(text) as { ac?: { lat?: number; lon?: number; alt_baro?: number | string; track?: number; nav_heading?: number }[] };
      const ac = (parsed.ac ?? []).find((row) => Number.isFinite(row.lat) && Number.isFinite(row.lon));
      if (ac && typeof ac.lat === "number" && typeof ac.lon === "number") {
        const alt = ac.alt_baro == null || ac.alt_baro === "ground" ? "" : `${ac.alt_baro} ft`;
        const track = Number.isFinite(ac.track) ? ac.track! : Number.isFinite(ac.nav_heading) ? ac.nav_heading! : 0;
        value = { lat: ac.lat, lon: ac.lon, alt, track };
      }
      break;
    } catch (error) {
      const retry = attempt < 2 && String(error).includes("429");
      if (!retry) break;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  fixes.set(key, { at: Date.now(), value });
  return value;
}

function etLabel(unix: number) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(unix * 1000));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${get("day")} ${get("month")}`, t: `${get("hour")}:${get("minute")}` };
}

function clockOnly(unix: number) {
  return unix ? etLabel(unix).t : "";
}

function partnerOf(fn: string) {
  const code = fn.toUpperCase().match(/^([A-Z0-9]{2})\d+$/)?.[1] ?? "";
  return code ? airlineCode(code) : "";
}

function gdpOf(xml: string, code: string): Program | null {
  for (const block of xml.match(/<Ground_Delay>[\s\S]*?<\/Ground_Delay>/g) ?? []) {
    const airport = block.match(/<ARPT>(.*?)<\/ARPT>/)?.[1];
    if (airport !== code) continue;
    return { airport, reason: block.match(/<Reason>(.*?)<\/Reason>/)?.[1] ?? "", avg: block.match(/<Avg>(.*?)<\/Avg>/)?.[1] ?? "" };
  }
  return null;
}

function icaoCallsign(fn: string, op: string | null | undefined): string {
  const embedded = (op ?? "").toUpperCase().match(/\b([A-Z]{3}\d{1,4})\b/);
  if (embedded) return embedded[1];
  const mapped = callsign(fn);
  return /^[A-Z]{3}\d{1,4}$/.test(mapped) ? mapped : "";
}

function edctLabel(text: string): string {
  if (text.includes("No EDCT information")) return "";
  const records: Date[] = [];
  const re = /(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})\s+\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}\s+[A-Z]{3,4}\s+(Yes|No)/g;
  for (const match of text.matchAll(re)) {
    if (match[6] === "Yes") continue;
    records.push(new Date(Date.UTC(+match[3], +match[1] - 1, +match[2], +match[4], +match[5])));
  }
  const now = Date.now();
  const fresh = records.filter((time) => time.getTime() >= now - 16 * 3600_000);
  const upcoming = fresh.filter((time) => time.getTime() >= now - 30 * 60_000).sort((a, b) => a.getTime() - b.getTime());
  const picked = upcoming[0] ?? fresh.sort((a, b) => b.getTime() - a.getTime())[0];
  if (picked) return `${String(picked.getUTCHours()).padStart(2, "0")}${String(picked.getUTCMinutes()).padStart(2, "0")}Z`;
  if (text.includes("not controlled at this time")) return "Not controlled";
  return "";
}

async function faaText(callsignValue: string, dept: string, arr: string): Promise<string> {
  const body = new URLSearchParams({ callsign: callsignValue, dept, arr }).toString();
  try {
    const response = await fetch("https://www.fly.faa.gov/edct/showEDCT", {
      method: "POST",
      headers: {
        "User-Agent": BROWSER,
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: "https://www.fly.faa.gov/edct/jsp/edctLookUp.jsp",
      },
      body,
      signal: AbortSignal.timeout(6000),
    });
    const text = await response.text();
    if (response.ok && !text.includes("Access Denied")) return text;
  } catch {
    // Python posts the same form when Node is refused.
  }
  return await new Promise((resolve, reject) => {
    execFile(
      "python3",
      [
        "-c",
        "import sys,urllib.request,urllib.parse\n" +
          "body=urllib.parse.urlencode({'callsign':sys.argv[1],'dept':sys.argv[2],'arr':sys.argv[3]}).encode()\n" +
          "req=urllib.request.Request('https://www.fly.faa.gov/edct/showEDCT', data=body, headers={'User-Agent':sys.argv[4],'Content-Type':'application/x-www-form-urlencoded','Referer':'https://www.fly.faa.gov/edct/jsp/edctLookUp.jsp'})\n" +
          "print(urllib.request.urlopen(req, timeout=12).read().decode('utf-8','replace'))",
        callsignValue,
        dept,
        arr,
        BROWSER,
      ],
      { maxBuffer: 2_000_000, timeout: 15000 },
      (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(stdout)),
    );
  });
}

async function lookupEdct(cs: string, dept: string, arr: string): Promise<string> {
  const key = `${cs}|${dept}|${arr}`;
  const hit = edctCache.get(key);
  if (hit && Date.now() - hit.at < 300_000) return hit.value;
  const text = (await faaText(cs, dept, arr)).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  if (text.includes("Access Denied")) throw new Error("FAA EDCT lookup was refused");
  const value = edctLabel(text);
  edctCache.set(key, { at: Date.now(), value });
  return value;
}

export async function inboundEdctFor(fn: string, from: string, op: string, arr = "BOS"): Promise<string> {
  const origin = from.toUpperCase();
  if (!isNorthAmerica(origin)) return "";
  const sign = icaoCallsign(fn, op);
  if (!sign) return "None filed";
  try {
    return (await lookupEdct(sign, origin, "BOS")) || "None filed";
  } catch {
    return "FAA unavailable";
  }
}

async function pullEdcts(flights: Flight[], arrivals: Arrival[]): Promise<Record<string, string>> {
  const jobs = new Map<string, { sign: string; from: string }>();
  const add = (fn: string, from: string, op: string) => {
    if (!fn || !isNorthAmerica(from)) return;
    const sign = icaoCallsign(fn, op);
    if (!sign) return;
    const key = `${fn}|${from}`;
    if (!jobs.has(key)) jobs.set(key, { sign, from });
  };
  for (const flight of flights) {
    if (flight.st === "Departed" || flight.st === "Cancelled") continue;
    add(flight.inbound, flight.inboundFrom, flight.inboundOp);
  }
  for (const row of arrivals) {
    if (row.st === "Landed" || row.st === "Cancelled") continue;
    add(row.fn, row.from, row.op);
  }
  const entries = [...jobs.entries()];
  const edcts: Record<string, string> = {};
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= entries.length) return;
      const [key, job] = entries[index];
      try {
        edcts[key] = (await lookupEdct(job.sign, job.from, "BOS")) || "None filed";
      } catch {
        edcts[key] = "FAA unavailable";
      }
    }
  }
  if (entries.length) await Promise.all(Array.from({ length: Math.min(2, entries.length) }, () => worker()));
  for (const flight of flights) flight.inboundEdct = edcts[`${flight.inbound}|${flight.inboundFrom}`] ?? "";
  return edcts;
}

function commercial(raw: RawFlight): boolean {
  const name = `${raw.airline?.name ?? ""} ${raw.owner?.name ?? ""}`.toLowerCase();
  return !PRIVATE.some((word) => name.includes(word));
}

function cityOf(side: AirportSide | undefined, iata: string): string {
  const city = side?.position?.region?.city?.trim();
  if (city) return city;
  if (AIRPORTS[iata]) return AIRPORTS[iata][0];
  return (side?.name ?? "").replace(/\s+(International\s+)?Airport.*/i, "").trim();
}

function clockOf(text: string): string {
  return text.match(/(\d{1,2}:\d{2})/)?.[1] ?? "";
}

function equipOf(raw: RawFlight): string {
  const code = String(raw.aircraft?.model?.code ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (code && code !== "NA") return code;
  const text = String(raw.aircraft?.model?.text ?? "").toUpperCase();
  return text.match(/\b([A-Z]{1,2}\d{2,3}[A-Z]?)\b/)?.[1] ?? "";
}

function arrivalPhase(raw: RawFlight): "sched" | "eta" | "landed" {
  const text = (raw.status?.text ?? "").replace(/\s+/g, " ").trim();
  const generic = (raw.status?.generic?.status?.text ?? "").toLowerCase();
  const arrived = (raw.time?.real?.arrival ?? 0) > 0 || generic === "landed" || /^landed|^arrived/i.test(text);
  if (arrived) return "landed";
  const off = (raw.time?.real?.departure ?? 0) > 0 || raw.status?.live === true;
  const estimated = generic === "estimated" || /^estimated\b/i.test(text);
  if (off || estimated) return "eta";
  return "sched";
}

function shownInbound(inbound: Leg | undefined): { eta: string; kind: Flight["inboundEtaKind"] } {
  if (!inbound) return { eta: "", kind: "" };
  const unix =
    inbound.phase === "landed" ? inbound.real || inbound.est || inbound.sched : inbound.phase === "eta" ? inbound.est || inbound.sched : inbound.sched;
  const when = etLabel(unix);
  const kind = inbound.phase === "landed" ? "Arrived" : inbound.phase === "eta" ? "ETA" : "Published";
  return { eta: `${when.date} ${when.t}`, kind };
}

function classify(raw: RawFlight, kind: "departure" | "arrival"): { st: Flight["st"]; detail: string } {
  const text = (raw.status?.text ?? "").replace(/\s+/g, " ").trim();
  const generic = (raw.status?.generic?.status?.text ?? "").toLowerCase();
  const sched = raw.time?.scheduled?.[kind] ?? 0;
  const est = raw.time?.estimated?.[kind] || (kind === "arrival" ? raw.time?.other?.eta : 0) || 0;
  const real = raw.time?.real?.[kind] ?? 0;
  const delay = sched && (real || est) ? Math.round(((real || est) - sched) / 60) : null;
  if (generic === "canceled" || /^cancel/i.test(text)) return { st: "Cancelled", detail: "Cancelled" };
  if (generic === "diverted" || /^diverted/i.test(text)) return { st: "Diverted", detail: text.slice(0, 32) || "Diverted" };
  if (kind === "departure" && (generic === "departed" || /^departed/i.test(text))) return { st: "Departed", detail: text || "Departed" };
  if (generic === "landed" || /^landed|^arrived/i.test(text)) return { st: "Landed", detail: text || "Landed" };
  if (generic === "delayed" || (delay != null && delay >= 15)) {
    const clock = clockOf(text);
    const late = delay != null && delay >= 15 ? `${delay}m late` : "Delayed";
    return { st: "Delayed", detail: clock ? `${late} · ${clock}` : late };
  }
  if (generic === "estimated" || (delay != null && delay < 15)) return { st: "On time", detail: "On time" };
  return { st: "Scheduled", detail: "Scheduled" };
}

function parseLeg(raw: RawFlight, kind: "departure" | "arrival"): Leg | null {
  if (!commercial(raw)) return null;
  const side = kind === "departure" ? raw.airport?.destination : raw.airport?.origin;
  const home = kind === "departure" ? raw.airport?.origin : raw.airport?.destination;
  const other = (side?.code?.iata ?? "").toUpperCase();
  const sched = raw.time?.scheduled?.[kind] ?? 0;
  if (!sched) return null;
  const call = (raw.identification?.callsign ?? "").toUpperCase();
  const printed = (raw.identification?.number?.default ?? "").toUpperCase().replace(/\s+/g, "");
  const fn = printed || iataFlight(call);
  if (!fn) return null;
  const real = raw.time?.real?.[kind] ?? 0;
  const est = raw.time?.estimated?.[kind] || (kind === "arrival" ? raw.time?.other?.eta : 0) || 0;
  const status = classify(raw, kind);
  const airline = (raw.airline?.name || raw.owner?.name || "").replace(/\s*\([^)]*\)/g, "").trim();
  return {
    fn,
    callsign: call,
    al: airline,
    op: `${airline} ${call}`.trim(),
    tail: (raw.aircraft?.registration ?? "").toUpperCase().replace(/\s+/g, ""),
    gate: (home?.info?.gate ?? "").trim(),
    other,
    city: cityOf(side, other),
    sched,
    est,
    real,
    event: real || est || sched,
    phase: kind === "arrival" ? arrivalPhase(raw) : "sched",
    equip: equipOf(raw),
    st: status.st,
    detail: status.detail,
  };
}

async function pyText(url: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile(
      "python3",
      [
        "-c",
        "import sys,urllib.request; r=urllib.request.Request(sys.argv[1], headers={'User-Agent':sys.argv[2],'Accept':'application/json','Referer':'https://www.flightradar24.com/'});\n" +
          "print(urllib.request.urlopen(r, timeout=20).read().decode('utf-8','replace'))",
        url,
        BROWSER,
      ],
      { maxBuffer: 8_000_000, timeout: 25000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

async function frText(url: string): Promise<string> {
  try {
    return await getText(url, BROWSER, 12000);
  } catch {
    return pyText(url);
  }
}

async function frBlock(code: string, mode: "departures" | "arrivals", page: number, timestamp: number) {
  const url =
    `https://api.flightradar24.com/common/v1/airport.json?code=${code}` +
    `&plugin[]=schedule&plugin-setting[schedule][mode]=${mode}` +
    `&plugin-setting[schedule][timestamp]=${timestamp}&page=${page}&limit=100`;
  const text = await frText(url);
  const parsed = JSON.parse(text) as {
    result?: { response?: { airport?: { pluginData?: { schedule?: Record<string, { data?: { flight?: RawFlight }[] }> } } } };
  };
  return parsed.result?.response?.airport?.pluginData?.schedule?.[mode]?.data ?? [];
}

async function loadMode(apt: BoardCode, mode: "departures" | "arrivals", timestamp: number, pages: number, horizon: number): Promise<Leg[]> {
  const kind = mode === "departures" ? "departure" : "arrival";
  const legs: Leg[] = [];
  const seen = new Set<string>();
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      for (let page = 1; page <= pages; page++) {
        const rows = await frBlock(apt, mode, page, timestamp);
        if (!rows.length) break;
        let newest = 0;
        for (const row of rows) {
          const raw = row.flight;
          if (!raw) continue;
          const leg = parseLeg(raw, kind);
          if (!leg) continue;
          newest = Math.max(newest, leg.sched);
          const key = `${leg.fn}|${leg.sched}|${leg.other}`;
          if (seen.has(key)) continue;
          seen.add(key);
          legs.push(leg);
          for (const shared of raw.identification?.codeshare ?? []) {
            const code = iataFlight(shared.toUpperCase().replace(/\s+/g, ""));
            if (code) seen.add(`${code}|${leg.sched}|${leg.other}`);
          }
        }
        if (newest > horizon) break;
      }
      if (legs.length) return legs;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (attempt >= 1 && /429|rate limit/i.test(message)) break;
      await new Promise((resolve) => setTimeout(resolve, /429|rate limit/i.test(message) ? 4000 * (attempt + 1) : 800 * (attempt + 1)));
    }
  }
  return legs;
}

function withoutCodeshares(legs: Leg[]): Leg[] {
  const groups = new Map<string, Leg[]>();
  for (const leg of legs) {
    const key = `${leg.sched}|${leg.other}`;
    const list = groups.get(key) ?? [];
    list.push(leg);
    groups.set(key, list);
  }
  const solo = new Map<string, number>();
  for (const list of groups.values()) {
    if (list.length === 1) solo.set(list[0].al, (solo.get(list[0].al) ?? 0) + 1);
  }
  const kept: Leg[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) {
      kept.push(...list);
      continue;
    }
    const best = Math.max(...list.map((leg) => solo.get(leg.al) ?? 0));
    const floor = Math.max(8, best * 0.25);
    const operators = list.filter((leg) => (solo.get(leg.al) ?? 0) >= floor);
    if (operators.length) kept.push(...operators);
    else kept.push(list.reduce((a, b) => ((solo.get(a.al) ?? 0) >= (solo.get(b.al) ?? 0) ? a : b)));
  }
  return kept;
}

function chooseList(primary: Leg[], backup: Leg[]): Leg[] {
  const score = (legs: Leg[]) => legs.length + legs.filter((leg) => leg.tail).length * 3;
  if (!primary.length) return backup;
  if (!backup.length) return primary;
  return score(primary) >= score(backup) ? primary : backup;
}

function pairTurns(departures: Leg[], arrivals: Leg[]) {
  const pool = new Map<string, Leg[]>();
  for (const leg of arrivals) {
    if (!leg.tail) continue;
    const list = pool.get(leg.tail) ?? [];
    list.push(leg);
    pool.set(leg.tail, list);
  }
  for (const list of pool.values()) list.sort((a, b) => a.event - b.event);
  const used = new Set<Leg>();
  const inbound = new Map<Leg, Leg>();
  for (const dep of [...departures].sort((a, b) => a.event - b.event)) {
    if (!dep.tail) continue;
    const list = pool.get(dep.tail);
    if (!list?.length) continue;
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < list.length; i++) {
      const gap = dep.event - list[i].event;
      if (gap < -15 * 60 || gap > 16 * 3600) continue;
      const score = gap >= 0 ? gap : 100000 + Math.abs(gap);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) continue;
    const removed = list.splice(0, best + 1);
    const chosen = removed[removed.length - 1];
    inbound.set(dep, chosen);
    for (const leg of removed) used.add(leg);
  }
  return { inbound, used };
}

function flightFrom(leg: Leg, inbound: Leg | undefined): Flight {
  const when = etLabel(leg.sched);
  const shown = shownInbound(inbound);
  return {
    date: when.date,
    t: when.t,
    iso: new Date(leg.sched * 1000).toISOString(),
    to: leg.other,
    city: leg.city,
    fn: leg.fn,
    al: leg.al,
    st: leg.st,
    detail: leg.detail,
    gate: leg.gate,
    inbound: inbound?.fn ?? "",
    inboundFrom: inbound?.other ?? "",
    inboundEta: shown.eta,
    inboundEtaKind: shown.kind,
    inboundGate: inbound?.gate ?? "",
    inboundStatus: inbound?.detail ?? "",
    inboundOp: inbound?.op ?? "",
    inboundEdct: "",
    tail: leg.tail,
    etd: clockOnly(leg.est || leg.real || leg.sched),
    equip: leg.equip || inbound?.equip || "",
  };
}

function arrivalFrom(leg: Leg): Arrival {
  const when = etLabel(leg.sched);
  return {
    date: when.date,
    t: when.t,
    iso: new Date(leg.sched * 1000).toISOString(),
    from: leg.other,
    city: leg.city,
    fn: leg.fn,
    al: leg.al,
    st: leg.st,
    detail: leg.detail,
    tail: leg.tail,
    gate: leg.gate,
    op: leg.op,
    eta: clockOnly(leg.est || leg.real || leg.sched),
    live: leg.phase === "eta",
    equip: leg.equip,
  };
}

function routingFrom(flight: Flight, inbound: Leg | undefined, dep: Leg): Routing {
  return {
    id: `${flight.tail || "notail"}|${flight.fn}|${flight.iso}`,
    tail: flight.tail || inbound?.tail || "",
    inbound: inbound?.fn ?? flight.inbound,
    inboundFrom: inbound?.other ?? flight.inboundFrom,
    inboundWhen: flight.inboundEta,
    inboundIso: inbound ? new Date((inbound.est || inbound.real || inbound.sched) * 1000).toISOString() : "",
    inboundGate: flight.inboundGate || inbound?.gate || "",
    inboundStatus: flight.inboundStatus || inbound?.detail || "",
    inboundKind: inbound?.st ?? "",
    outbound: flight.fn,
    outboundTo: flight.to,
    outboundCity: flight.city,
    outboundWhen: `${flight.date} ${flight.t}`,
    outboundIso: flight.iso,
    outboundGate: flight.gate,
    outboundStatus: flight.detail,
    outboundKind: flight.st,
    toa: inbound ? clockOnly(inbound.sched) : "",
    eta: inbound ? clockOnly(inbound.est || inbound.real || inbound.sched) : "",
    tod: "",
    etd: clockOnly(dep.est || dep.real || dep.sched),
    partner: partnerOf(flight.fn) || partnerOf(inbound?.fn ?? ""),
    sort: flight.iso,
    equip: dep.equip || flight.equip || inbound?.equip || "",
  };
}

function arrivalRouting(leg: Leg): Routing {
  const when = etLabel(leg.event);
  const iso = new Date(leg.event * 1000).toISOString();
  return {
    id: `${leg.tail}|in|${leg.fn}|${leg.sched}`,
    tail: leg.tail,
    inbound: leg.fn,
    inboundFrom: leg.other,
    inboundWhen: `${when.date} ${when.t}`,
    inboundIso: iso,
    inboundGate: leg.gate,
    inboundStatus: leg.detail,
    inboundKind: leg.st,
    outbound: "",
    outboundTo: "",
    outboundCity: "",
    outboundWhen: "",
    outboundIso: "",
    outboundGate: "",
    outboundStatus: "",
    outboundKind: "",
    toa: clockOnly(leg.sched),
    eta: clockOnly(leg.est || leg.real || leg.sched),
    tod: "",
    etd: "",
    partner: partnerOf(leg.fn),
    sort: iso,
    equip: leg.equip,
  };
}

function shareBoard(flights: Flight[], arrivals: Arrival[], routings: Routing[]) {
  const byDep = new Map(flights.map((flight) => [`${flight.fn}|${flight.to}`, flight]));
  const byArr = new Map(arrivals.map((row) => [`${row.fn}|${row.from}`, row]));
  for (const row of routings) {
    const dep = byDep.get(`${row.outbound}|${row.outboundTo}`);
    const arr = byArr.get(`${row.inbound}|${row.inboundFrom}`);
    if (arr) {
      row.toa = row.toa || arr.t;
      row.eta = row.eta || arr.eta || arr.t;
      row.inboundGate = row.inboundGate || arr.gate;
      row.tail = row.tail || arr.tail;
      row.inboundStatus = row.inboundStatus || arr.detail;
      row.partner = row.partner || partnerOf(arr.fn);
      row.equip = row.equip || arr.equip;
      if (!arr.equip && row.equip) arr.equip = row.equip;
      if (!arr.eta) arr.eta = row.eta;
      if (!arr.tail && row.tail) arr.tail = row.tail;
    }
    if (dep) {
      row.etd = row.etd || dep.etd || dep.t;
      row.outboundGate = row.outboundGate || dep.gate;
      row.tail = row.tail || dep.tail;
      row.outboundStatus = row.outboundStatus || dep.detail;
      row.partner = partnerOf(dep.fn) || row.partner;
      row.equip = row.equip || dep.equip;
      if (!dep.equip && row.equip) dep.equip = row.equip;
      if (!dep.etd) dep.etd = row.etd;
      if (!dep.tail && row.tail) dep.tail = row.tail;
      if (!dep.inbound && row.inbound) {
        dep.inbound = row.inbound;
        dep.inboundFrom = row.inboundFrom;
        dep.inboundEta = row.inboundWhen;
        dep.inboundEtaKind = row.inboundKind === "Landed" ? "Arrived" : "Published";
        dep.inboundGate = row.inboundGate;
        dep.inboundStatus = row.inboundStatus;
      }
    }
  }
}

function spanHours(data: Snapshot): number {
  let min = Infinity;
  let max = -Infinity;
  for (const flight of data.flights) {
    const time = Date.parse(flight.iso);
    if (Number.isNaN(time)) continue;
    if (time < min) min = time;
    if (time > max) max = time;
  }
  if (!Number.isFinite(min) || max < min) return 0;
  return (max - min) / 3_600_000;
}

function boardOk(next: Snapshot, prev: Snapshot | null): boolean {
  if (next.flights.length < 25) return false;
  if (!prev || prev.flights.length < 80) return true;
  if (next.flights.length < prev.flights.length * 0.65) return false;
  if (spanHours(prev) >= 8 && spanHours(next) < 4) return false;
  return true;
}

function readCache(apt: BoardCode, maxAge: number, minFlights = 0, exact = false): Snapshot | null {
  const hit = caches.get(apt);
  if (hit && (!exact || hit.v === CACHE_VERSION) && Date.now() - hit.at < maxAge && hit.data.flights.length >= minFlights) return hit.data;
  try {
    const parsed = JSON.parse(readFileSync(`/tmp/logan-board-${apt}.json`, "utf8")) as { v?: number; at?: number; data?: Snapshot };
    const current = exact ? parsed.v === CACHE_VERSION : parsed.v != null && parsed.v >= 13;
    if (!current || !parsed.at || !parsed.data?.flights || parsed.data.airport !== apt) return null;
    if (Date.now() - parsed.at > maxAge || parsed.data.flights.length < minFlights) return null;
    caches.set(apt, { at: parsed.at, v: CACHE_VERSION, data: parsed.data });
    return parsed.data;
  } catch {
    return null;
  }
}

function writeCache(apt: BoardCode, data: Snapshot) {
  const prior = readCache(apt, 18 * 3600_000, 25);
  if (!boardOk(data, prior)) return;
  const row = { at: Date.now(), v: CACHE_VERSION, data };
  caches.set(apt, row);
  try {
    writeFileSync(`/tmp/logan-board-${apt}.json`, JSON.stringify({ v: CACHE_VERSION, at: row.at, data }));
  } catch {
    // Memory still serves the board if the disk write misses.
  }
}

function etSlot(time: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(time);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") };
}

function legFromList(row: FsRow): Leg | null {
  const fn = `${(row.carrier?.fs ?? "").toUpperCase()}${String(row.carrier?.flightNumber ?? "")}`.replace(/\s+/g, "");
  const name = row.carrier?.name ?? "";
  const blob = `${name} ${row.operatedBy ?? ""}`.toLowerCase();
  if (!fn || !row.sortTime || PRIVATE.some((word) => blob.includes(word))) return null;
  const op = row.operatedBy ?? "";
  if (op && !op.toLowerCase().includes(name.toLowerCase()) && !/on behalf/i.test(op)) return null;
  const sched = Math.floor(Date.parse(row.sortTime) / 1000);
  if (!sched) return null;
  const other = (row.airport?.fs ?? "").toUpperCase();
  return {
    fn,
    callsign: "",
    al: name.replace(/\s*\([^)]*\)/g, "").trim(),
    op: (row.operatedBy || name).trim(),
    tail: "",
    gate: "",
    other,
    city: row.airport?.city || AIRPORTS[other]?.[0] || other,
    sched,
    est: 0,
    real: 0,
    event: sched,
    phase: "sched",
    equip: "",
    st: "Scheduled",
    detail: "Scheduled",
  };
}

async function fsList(apt: BoardCode, mode: "dep" | "arr", slot: { y: number; m: number; d: number; h: number }): Promise<Leg[]> {
  const text = await getText(
    `https://www.flightstats.com/v2/api-next/flight-tracker/${mode}/${apt}/${slot.y}/${slot.m}/${slot.d}/${slot.h}`,
    BROWSER,
    8000,
    "https://www.flightstats.com/",
  );
  const rows = (JSON.parse(text) as { data?: { flights?: FsRow[] } }).data?.flights ?? [];
  return rows.map(legFromList).filter((leg): leg is Leg => !!leg);
}

async function loadBoard(apt: BoardCode, mode: "dep" | "arr", now: Date): Promise<Leg[]> {
  const slots = [-6, 0, 6, 12].map((shift) => etSlot(new Date(now.getTime() + shift * 3600_000)));
  const unique = new Map<string, { y: number; m: number; d: number; h: number }>();
  for (const slot of slots) unique.set(`${slot.y}-${slot.m}-${slot.d}-${slot.h}`, slot);
  const seen = new Set<string>();
  const legs: Leg[] = [];
  for (const slot of unique.values()) {
    try {
      for (const leg of await fsList(apt, mode, slot)) {
        const key = `${leg.fn}|${leg.sched}|${leg.other}`;
        if (seen.has(key)) continue;
        seen.add(key);
        legs.push(leg);
      }
    } catch {
      // One hour can fail without dropping the rest.
    }
  }
  legs.sort((a, b) => a.sched - b.sched);
  return legs;
}

function statusFromDetail(raw: Record<string, unknown>, kind: "departure" | "arrival"): { st: Flight["st"]; detail: string } {
  const note = (raw.flightNote ?? {}) as { canceled?: boolean; landed?: boolean; hasDepartedGate?: boolean; hasDepartedRunway?: boolean; message?: string };
  const status = (raw.status ?? {}) as {
    statusCode?: string;
    status?: string;
    statusDescription?: string;
    diverted?: boolean;
    delay?: { departure?: { minutes?: number }; arrival?: { minutes?: number } };
  };
  const code = status.statusCode ?? "";
  const delay = kind === "departure" ? status.delay?.departure?.minutes : status.delay?.arrival?.minutes;
  if (note.canceled || code === "C") return { st: "Cancelled", detail: "Cancelled" };
  if (status.diverted || code === "D") return { st: "Diverted", detail: "Diverted" };
  if (kind === "arrival" && (note.landed || code === "L")) return { st: "Landed", detail: note.message || "Landed" };
  if (kind === "departure" && (note.hasDepartedRunway || note.hasDepartedGate || code === "A" || code === "L")) return { st: "Departed", detail: "Departed" };
  if (delay != null && delay >= 15) return { st: "Delayed", detail: `Delayed ${delay}m` };
  if (/on time/i.test(status.statusDescription ?? "") || /on time/i.test(status.status ?? "")) return { st: "On time", detail: "On time" };
  return { st: "Scheduled", detail: status.statusDescription || "Scheduled" };
}

function applyDetail(leg: Leg, raw: Record<string, unknown>, kind: "departure" | "arrival") {
  const positional = raw.positional as { flexTrack?: { tailNumber?: string } } | undefined;
  const tail = String(positional?.flexTrack?.tailNumber ?? "")
    .toUpperCase()
    .replace(/\s+/g, "");
  const text = JSON.stringify(raw);
  const filed = text.match(/"callsign"\s*:\s*"([A-Z]{3}\d{1,4}[A-Z]?)"/)?.[1] ?? "";
  if (tail) leg.tail = tail;
  if (filed) {
    leg.callsign = filed;
    leg.op = `${String(raw.operatedBy || leg.op)} ${filed}`.trim();
  }
  const home = (kind === "departure" ? raw.departureAirport : raw.arrivalAirport) as { gate?: string } | undefined;
  if (home?.gate) leg.gate = String(home.gate);
  const status = statusFromDetail(raw, kind);
  leg.st = status.st;
  leg.detail = status.detail;
  const schedule = (raw.schedule ?? {}) as { estimatedActualDepartureUTC?: string; estimatedActualArrivalUTC?: string };
  const utc = kind === "departure" ? schedule.estimatedActualDepartureUTC : schedule.estimatedActualArrivalUTC;
  const event = utc ? Math.floor(Date.parse(utc) / 1000) : 0;
  if (event) {
    leg.est = leg.est || event;
    leg.event = leg.real || leg.est || leg.sched;
  }
}

function stampKnownTails(depLegs: Leg[], arrLegs: Leg[]) {
  const prior = readCache("BOS", 12 * 3600_000, 25);
  if (!prior) return;
  const index = new Map<string, { sched: number; tail: string }[]>();
  const add = (fn: string, other: string, iso: string, tail: string) => {
    if (!fn || !other || !tail) return;
    const sched = Math.floor(Date.parse(iso) / 1000);
    if (!sched) return;
    const key = `${fn}|${other}`;
    const list = index.get(key) ?? [];
    list.push({ sched, tail });
    index.set(key, list);
  };
  for (const flight of prior.flights) add(flight.fn, flight.to, flight.iso, flight.tail);
  for (const row of prior.arrivals) add(row.fn, row.from, row.iso, row.tail);
  const apply = (leg: Leg) => {
    if (leg.tail) return;
    const list = index.get(`${leg.fn}|${leg.other}`);
    if (!list) return;
    let best = "";
    let gap = 45 * 60;
    for (const item of list) {
      const delta = Math.abs(item.sched - leg.sched);
      if (delta < gap) {
        gap = delta;
        best = item.tail;
      }
    }
    if (best) leg.tail = best;
  };
  for (const leg of depLegs) apply(leg);
  for (const leg of arrLegs) apply(leg);
}

async function enrichLegs(legs: Leg[], kind: "departure" | "arrival", nowSec: number) {
  const wanted = legs
    .filter((leg) => !leg.tail && leg.sched >= nowSec - 2 * 3600 && leg.sched <= nowSec + 12 * 3600)
    .sort((a, b) => Math.abs(a.sched - nowSec) - Math.abs(b.sched - nowSec))
    .slice(0, 160);
  const deadline = Date.now() + 12000;
  let index = 0;
  async function run() {
    while (index < wanted.length && Date.now() < deadline) {
      const leg = wanted[index++];
      const match = leg.fn.match(/^([A-Z0-9]{2})(\d{1,4})$/);
      if (!match) continue;
      const slot = etSlot(new Date(leg.sched * 1000));
      try {
        const text = await getText(
          `https://www.flightstats.com/v2/api-next/flight-tracker/${match[1]}/${match[2]}/${slot.y}/${slot.m}/${slot.d}`,
          BROWSER,
          4000,
          "https://www.flightstats.com/",
        );
        const raw = (JSON.parse(text) as { data?: Record<string, unknown> }).data;
        if (raw) applyDetail(leg, raw, kind);
      } catch {
        // The row still shows from the schedule if this call misses.
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, run));
}

async function collectLegs(apt: BoardCode, now: Date) {
  const nowSec = Math.floor(now.getTime() / 1000);
  const frDep = await loadMode(apt, "departures", nowSec - 2 * 3600, 8, nowSec + 12 * 3600).catch(() => []);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  let frArr = await loadMode(apt, "arrivals", nowSec - 8 * 3600, 8, nowSec + 12 * 3600).catch(() => []);
  if (!frArr.length) {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    frArr = await loadMode(apt, "arrivals", nowSec - 8 * 3600, 8, nowSec + 12 * 3600).catch(() => []);
  }
  let fsDep: Leg[] = [];
  let fsArr: Leg[] = [];
  if (frDep.length < MIN_BOARD || frArr.length < MIN_BOARD) {
    [fsDep, fsArr] = await Promise.all([
      frDep.length >= MIN_BOARD ? Promise.resolve([]) : loadBoard(apt, "dep", now),
      frArr.length >= MIN_BOARD ? Promise.resolve([]) : loadBoard(apt, "arr", now),
    ]);
  }
  return { depLegs: withoutCodeshares(chooseList(frDep, fsDep)), arrLegs: withoutCodeshares(chooseList(frArr, fsArr)) };
}

async function buildSnapshot(apt: BoardCode): Promise<Snapshot> {
  const board = BOARDS[apt];
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const start = nowSec - 90 * 60;
  const end = nowSec + 12 * 3600;
  let note = "";
  let gdp: Program | null = null;
  let flights: Flight[] = [];
  let arrivals: Arrival[] = [];
  let routings: Routing[] = [];
  try {
    const [{ depLegs, arrLegs }, nas] = await Promise.all([
      collectLegs(apt, now),
      getText("https://nasstatus.faa.gov/api/airport-status-information", UA, 8000).catch(() => ""),
    ]);
    stampKnownTails(depLegs, arrLegs);
    await Promise.all([enrichLegs(depLegs, "departure", nowSec), enrichLegs(arrLegs, "arrival", nowSec)]);
    gdp = nas ? gdpOf(nas, apt) : null;
    const departures = depLegs.filter((leg) => leg.sched >= start && leg.sched <= end);
    const linkArrivals = arrLegs.filter((leg) => leg.sched >= nowSec - 8 * 3600 && leg.sched <= end);
    const shownArrivals = linkArrivals.filter((leg) => leg.sched >= start && leg.sched <= end);
    const paired = pairTurns(departures, linkArrivals);
    flights = departures.map((leg) => flightFrom(leg, paired.inbound.get(leg)));
    arrivals = shownArrivals.map(arrivalFrom);
    const loose: Routing[] = [];
    const byTail = new Map<string, { flight: Flight; inbound?: Leg; dep: Leg }>();
    const nowMs = now.getTime();
    for (let i = 0; i < departures.length; i++) {
      const flight = flights[i];
      const dep = departures[i];
      const inbound = paired.inbound.get(dep);
      if (!flight?.tail) {
        loose.push(routingFrom(flight, inbound, dep));
        continue;
      }
      const row = { flight, inbound, dep };
      const current = byTail.get(flight.tail);
      const flightAt = Date.parse(flight.iso);
      const currentAt = current ? Date.parse(current.flight.iso) : 0;
      const upcoming = flightAt >= nowMs - 90 * 60_000;
      const currentUpcoming = currentAt >= nowMs - 90 * 60_000;
      const better = !current || (upcoming && (!currentUpcoming || flightAt < currentAt)) || (!upcoming && !currentUpcoming && flightAt > currentAt);
      if (better) byTail.set(flight.tail, row);
    }
    routings = [...byTail.values()].map(({ flight, inbound, dep }) => routingFrom(flight, inbound, dep)).concat(loose);
    for (const leg of shownArrivals) {
      if (!leg.tail || paired.used.has(leg) || byTail.has(leg.tail)) continue;
      routings.push(arrivalRouting(leg));
    }
    routings.sort((a, b) => a.sort.localeCompare(b.sort));
    shareBoard(flights, arrivals, routings);
    const edcts = await pullEdcts(flights, arrivals);
    const held = readCache(apt, 18 * 3600_000, 25);
    const data: Snapshot = {
      pulled: now.toISOString(),
      count: flights.length,
      note,
      airport: apt,
      airportName: board.name,
      gdp,
      flights,
      arrivals,
      routings,
      edcts,
    };
    if (!boardOk(data, held)) {
      if (held?.routings?.some((row) => row.outbound)) {
        return { ...held, note: "Live feed was short, so the last full board is still up." };
      }
    }
    if (flights.length >= 25) writeCache(apt, data);
    return data;
  } catch {
    note = "The live board did not answer. Try refresh.";
  }
  const held = readCache(apt, 18 * 3600_000, 25);
  if (held) return { ...held, note: note || held.note || "Live feed was short, so the last full board is still up." };
  return { pulled: now.toISOString(), count: 0, note, airport: apt, airportName: board.name, gdp, flights, arrivals, routings, edcts: {} };
}

export async function loadSnapshot(apt: BoardCode = "BOS", force = false): Promise<Snapshot> {
  if (!force) {
    const fresh = readCache(apt, 10 * 60_000, 25, false);
    if (fresh?.routings?.some((row) => row.outbound)) return fresh;
  }
  return buildSnapshot(apt);
}

export async function inboundForDeparture(fn: string, iso: string): Promise<Turn> {
  const depMs = Date.parse(iso);
  if (!fn || Number.isNaN(depMs)) return EMPTY;
  const cacheKey = `${fn}|${iso}`;
  const cached = turnCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 600_000) return cached.value;
  const match = fn.toUpperCase().match(/^([A-Z0-9]{2})(\d{1,4})$/);
  if (!match) return EMPTY;
  try {
    const slot = etSlot(new Date(depMs));
    const text = await getText(`https://www.flightstats.com/v2/api-next/flight-tracker/${match[1]}/${match[2]}/${slot.y}/${slot.m}/${slot.d}`, BROWSER, 8000);
    const raw = (JSON.parse(text) as { data?: Record<string, unknown> }).data;
    const value: Turn = { ...EMPTY };
    if (raw) {
      const leg: Leg = {
        fn,
        callsign: "",
        al: "",
        op: "",
        tail: "",
        gate: "",
        other: "",
        city: "",
        sched: Math.floor(depMs / 1000),
        est: 0,
        real: 0,
        event: Math.floor(depMs / 1000),
        phase: "sched",
        equip: "",
        st: "Scheduled",
        detail: "Scheduled",
      };
      applyDetail(leg, raw, "departure");
      value.tail = leg.tail;
      value.inboundOp = leg.op;
    }
    const snap = readCache("BOS", 6 * 3600_000);
    const hit = snap?.arrivals.filter((row) => row.tail && row.tail === value.tail && Date.parse(row.iso) <= depMs + 15 * 60_000).sort((a, b) => Date.parse(b.iso) - Date.parse(a.iso))[0];
    if (hit) {
      const landed = hit.st === "Landed";
      const kind = landed ? "Arrived" : hit.live ? "ETA" : "Published";
      const clock = kind === "Published" ? hit.t : hit.eta || hit.t;
      value.inbound = hit.fn;
      value.inboundFrom = hit.from;
      value.inboundEta = `${hit.date} ${clock}`;
      value.inboundEtaKind = kind;
      value.inboundGate = hit.gate;
      value.inboundStatus = hit.detail;
      value.inboundOp = hit.op || value.inboundOp;
    }
    turnCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch {
    return EMPTY;
  }
}
