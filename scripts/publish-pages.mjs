import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "site");

const { AIRPORTS, BOS, callsign } = await import("../src/lib/flights.ts");

async function snapshot() {
  if (process.env.BOARD_CACHE) {
    const parsed = JSON.parse(readFileSync(process.env.BOARD_CACHE, "utf8"));
    return parsed.data ?? parsed;
  }
  const { loadSnapshot } = await import("../src/lib/logan.server.ts");
  return loadSnapshot("BOS", true);
}

const data = await snapshot();
if (!data?.flights || data.flights.length < 25) {
  console.error(`Refusing to publish a short board (${data?.flights?.length ?? 0} flights).`);
  process.exit(1);
}

async function adsbFix(tail) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`https://api.adsb.lol/v2/reg/${encodeURIComponent(tail)}`, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
      continue;
    }
    if (!response.ok) return null;
    const parsed = await response.json();
    const ac = (parsed.ac ?? []).find((item) => Number.isFinite(item.lat) && Number.isFinite(item.lon));
    if (!ac) return null;
    return {
      lat: ac.lat,
      lon: ac.lon,
      alt: ac.alt_baro == null || ac.alt_baro === "ground" ? "" : `${ac.alt_baro} ft`,
      track: Number.isFinite(ac.track) ? ac.track : Number.isFinite(ac.nav_heading) ? ac.nav_heading : 0,
      call: String(ac.flight || "").trim(),
    };
  }
  return null;
}

function enroute(row, kind) {
  if (!row?.tail) return false;
  if (row.st === "Landed" || row.st === "Cancelled" || row.st === "Diverted") return false;
  if (kind === "dep") return row.st === "Departed";
  return Boolean(row.live || row.st === "Estimated" || row.st === "Airborne");
}

async function flightPlan(call, row) {
  const filed = String(call || "").trim();
  if (filed) {
    try {
      const response = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(filed)}`, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (response.ok) {
        const parsed = await response.json();
        const route = parsed.response?.flightroute;
        const origin = route?.origin;
        const dest = route?.destination;
        if (Number.isFinite(origin?.latitude) && Number.isFinite(dest?.latitude)) {
          return {
            from: origin.iata_code || origin.icao_code || "",
            to: dest.iata_code || dest.icao_code || "",
            a: [origin.latitude, origin.longitude],
            b: [dest.latitude, dest.longitude],
          };
        }
      }
    } catch {
      // Fall back to the airport pair already on the board.
    }
  }
  if (row.from && AIRPORTS[row.from]) return { from: row.from, to: "BOS", a: [AIRPORTS[row.from][1], AIRPORTS[row.from][2]], b: [...BOS] };
  if (row.to && AIRPORTS[row.to]) return { from: "BOS", to: row.to, a: [...BOS], b: [AIRPORTS[row.to][1], AIRPORTS[row.to][2]] };
  return null;
}

async function attachFixes(rows) {
  const seen = new Set();
  let found = 0;
  let plans = 0;
  for (const row of rows) {
    if (!row.tail || seen.has(row.tail)) continue;
    seen.add(row.tail);
    try {
      const fix = await adsbFix(row.tail);
      const plan = await flightPlan(fix?.call || callsign(row.fn || ""), row);
      if (fix) found += 1;
      if (plan) plans += 1;
      for (const other of rows) {
        if (other.tail !== row.tail) continue;
        if (fix) other.fix = fix;
        if (plan) other.plan = plan;
      }
    } catch {
      // A missing fix just leaves the route line.
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  console.log(`ADS-B positions: ${found} of ${seen.size} enroute tails, flight plans: ${plans}`);
}

const tracked = [
  ...(data.arrivals ?? []).filter((row) => enroute(row, "arr")),
  ...(data.flights ?? []).filter((row) => enroute(row, "dep")),
];
await attachFixes(tracked);
const fixByTail = new Map(tracked.filter((row) => row.fix).map((row) => [row.tail, row.fix]));
const planByTail = new Map(tracked.filter((row) => row.plan).map((row) => [row.tail, row.plan]));
for (const row of data.routings ?? []) {
  if (!row.tail) continue;
  if (fixByTail.has(row.tail)) row.fix = fixByTail.get(row.tail);
  if (planByTail.has(row.tail)) row.plan = planByTail.get(row.tail);
}

const used = new Set(["BOS"]);
for (const flight of data.flights) used.add(flight.to);
for (const row of data.arrivals ?? []) used.add(row.from);
for (const row of data.routings ?? []) {
  if (row.outboundTo) used.add(row.outboundTo);
  if (row.inboundFrom) used.add(row.inboundFrom);
}
const places = {};
for (const code of used) {
  if (AIRPORTS[code]) places[code] = AIRPORTS[code];
}

const payload = JSON.stringify({
  pulled: data.pulled,
  note: data.note || "",
  gdp: data.gdp,
  flights: data.flights,
  arrivals: data.arrivals ?? [],
  routings: data.routings ?? [],
  edcts: data.edcts ?? {},
  places,
  bos: BOS,
}).replace(/</g, "\\u003c");

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Boston Logan Airport Flight Board</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect fill='%230e3a5d' width='32' height='32' rx='6'/%3E%3Cpath fill='%23f4efe6' d='M6 18h8l4-6h6l-2 6h4l2 2H6z'/%3E%3C/svg%3E" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500&family=Source+Sans+3:wght@400;600;700&display=swap" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    :root { --paper:#f4efe6; --card:#fffdf8; --ink:#14202b; --navy:#0e3a5d; --rust:#c4512c; --line:#e2d8c8; --mute:#6d645a; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--paper); color: var(--ink); font-family: "Source Sans 3", "Segoe UI", sans-serif; }
    button { cursor: pointer; font: inherit; }
    header { display: flex; flex-wrap: wrap; gap: 16px; justify-content: space-between; align-items: flex-end; padding: 16px 24px 8px; }
    h1 { font-family: Fraunces, Georgia, serif; font-weight: 500; font-size: 2.4rem; margin: 0; letter-spacing: -0.03em; }
    .kicker { margin: 0; font-size: 12px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: var(--navy); }
    .sub { margin: 4px 0 0; color: var(--mute); font-size: 14px; }
    .stats { display: flex; gap: 8px; }
    .stat { min-width: 96px; border: 1px solid var(--line); background: var(--card); border-radius: 16px; padding: 8px 12px; }
    .stat b { display: block; font-family: Fraunces, Georgia, serif; font-size: 1.4rem; line-height: 1; }
    .stat span { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--mute); }
    .layout { display: grid; grid-template-columns: 1fr; gap: 12px; padding: 12px; }
    @media (min-width: 1024px) { .layout { grid-template-columns: 1fr 1fr; height: calc(100dvh - 150px); } .map, .board { height: 100%; } }
    .map, .board { background: var(--card); border: 1px solid var(--line); border-radius: 16px; overflow: hidden; min-height: 320px; }
    .board { display: flex; flex-direction: column; height: 70dvh; }
    @media (min-width: 1024px) { .board { height: 100%; } }
    .tools { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px; border-bottom: 1px solid var(--line); }
    .tabs { display: flex; gap: 4px; background: var(--paper); border: 1px solid var(--line); border-radius: 999px; padding: 4px; }
    .tabs button, select, input { min-height: 44px; border-radius: 999px; border: 1px solid var(--line); background: var(--paper); color: var(--ink); padding: 0 14px; }
    .tabs button { border: 0; background: transparent; font-weight: 700; }
    .tabs button.on { background: var(--navy); color: var(--paper); }
    input { min-width: 140px; flex: 1; }
    .scroll { overflow: auto; min-height: 0; flex: 1; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { text-align: left; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--mute); padding: 8px 12px; position: sticky; top: 0; background: var(--card); }
    td { padding: 8px 12px; border-top: 1px solid var(--line); vertical-align: top; }
    tr.on { background: var(--paper); }
    .mute { color: var(--mute); font-size: 12px; }
    .pill { display: inline-flex; border-radius: 999px; padding: 2px 8px; font-size: 12px; font-weight: 700; white-space: nowrap; }
    .bad { background: #f8e6df; color: var(--rust); }
    .good { background: #e4edf4; color: var(--navy); }
    .wait { background: var(--line); color: var(--ink); }
    .logo { height: 20px; width: 48px; object-fit: contain; object-position: left; }
    .logo.shield { width: 18px; height: 22px; }
    .plane-pin { background: none; border: none; }
    .leaflet-tooltip.plan-tag { background: #f4efe4; border: 0; color: #14202b; font-weight: 700; box-shadow: none; }
    #pull { background: var(--navy); color: var(--paper); border: 0; font-weight: 700; }
    #pull:disabled { opacity: 0.7; }
    #map { height: 100%; min-height: 320px; }
  </style>
</head>
<body>
  <header>
    <div>
      <p class="kicker">Boston Logan · KBOS</p>
      <h1 id="title">Departures</h1>
      <p class="sub" id="blurb"></p>
    </div>
    <div class="stats" id="stats"></div>
  </header>
  <div class="layout">
    <div class="map"><div id="map"></div></div>
    <section class="board">
      <div class="tools">
        <div class="tabs" role="tablist">
          <button type="button" id="tab-dep" class="on">Departures</button>
          <button type="button" id="tab-arr">Arrivals</button>
          <button type="button" id="tab-lard">LARD</button>
        </div>
        <input id="q" placeholder="City, flight, tail" />
        <select id="status"><option value="">All statuses</option><option>On time</option><option>Delayed</option><option>Departed</option><option>Landed</option><option>Scheduled</option><option>Cancelled</option></select>
        <select id="airline"><option value="">All airlines</option></select>
        <select id="span"><option value="">Any time</option><option value="1">Next hour</option><option value="3">Next 3 hours</option><option value="6">Next 6 hours</option></select>
        <select id="equip"><option value="">All aircraft</option></select>
        <select id="place"><option value="">All destinations</option></select>
        <button type="button" id="pull">Pull now</button>
      </div>
      <div class="scroll"><table><thead id="head"></thead><tbody id="body"></tbody></table></div>
    </section>
  </div>
  <footer>Pull now loads the live schedule. Otherwise this copy rebuilds every 10 minutes. Last pull <span id="pulled"></span>. <span id="pull-note"></span></footer>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>const DATA = ${payload};</script>
  <script>
    const $ = (id) => document.getElementById(id);
    let tab = "dep";
    let selected = "";
    const within = (iso) => {
      const t = Date.parse(iso);
      if (!Number.isFinite(t)) return false;
      const now = Date.now();
      return t >= now - 90 * 60 * 1000 && t <= now + 12 * 3600 * 1000;
    };
    const hoursOk = (iso) => {
      const span = $("span").value;
      if (!span) return true;
      const t = Date.parse(iso);
      return Number.isFinite(t) && t >= Date.now() - 20 * 60 * 1000 && t <= Date.now() + Number(span) * 3600 * 1000;
    };
    const carrier = (fn) => {
      const code = (String(fn || "").toUpperCase().match(/^([A-Z0-9]{2})\d/) || [])[1] || "";
      return code === "5X" ? "UPS" : code;
    };
    const mark = (code) => (code === "5X" ? "UPS" : code);
    const logoSrc = (code) => code === "UPS" || code === "5X"
      ? "https://upload.wikimedia.org/wikipedia/commons/thumb/6/6b/United_Parcel_Service_logo_2014.svg/250px-United_Parcel_Service_logo_2014.svg.png"
      : "https://pics.avs.io/120/36/" + code + ".png";
    const pill = (st, detail) => {
      const kind = /cancel|delay|divert/i.test(st) ? "bad" : /depart|land|on time|airborne/i.test(st) ? "good" : "wait";
      return '<span class="pill ' + kind + '">' + esc(detail || st || "—") + "</span>";
    };
    const esc = (s) => String(s ?? "").replace(/&/g, "&\u0061mp;").replace(/</g, "&\u006ct;").replace(/>/g, "&\u0067t;").replace(/"/g, "&\u0071uot;");
    let flights = (DATA.flights || []).filter((f) => within(f.iso));
    let arrivals = (DATA.arrivals || []).filter((f) => within(f.iso));
    let routings = (DATA.routings || []).filter((f) => within(f.outboundIso || f.inboundIso));
    function fill(select, values, all) {
      const current = select.value;
      select.innerHTML = '<option value="">' + all + "</option>" + values.map((v) => '<option>' + esc(v) + "</option>").join("");
      if ([...select.options].some((o) => o.value === current)) select.value = current;
    }
    function choices() {
      const airlines = new Set();
      const types = new Set();
      const places = new Set();
      const rows = tab === "arr" ? arrivals : tab === "lard" ? routings : flights;
      for (const row of rows) {
        const code = tab === "lard" ? mark(row.partner || carrier(row.outbound) || carrier(row.inbound)) : carrier(row.fn);
        if (code) airlines.add(code);
        if (row.equip) types.add(row.equip);
        const place = tab === "arr" ? row.from : tab === "lard" ? row.outboundTo || row.inboundFrom : row.to;
        if (place) places.add(place);
      }
      fill($("airline"), [...airlines].sort(), "All airlines");
      fill($("equip"), [...types].sort(), "All aircraft");
      fill($("place"), [...places].sort(), tab === "arr" ? "All origins" : "All destinations");
    }
    function matchStatus(st, departedHidden) {
      const status = $("status").value;
      if (status === "Departed") return st === "Departed";
      if (departedHidden && st === "Departed") return false;
      return !status || st === status;
    }
    function queryHit(blob) {
      const q = $("q").value.trim().toLowerCase();
      return !q || blob.includes(q);
    }
    function rows() {
      const airline = $("airline").value;
      const kind = $("equip").value;
      const place = $("place").value;
      if (tab === "arr") {
        return arrivals.filter((row) => carrier(row.fn) === (airline || carrier(row.fn)) && (!kind || row.equip === kind) && (!place || row.from === place) && hoursOk(row.iso) && matchStatus(row.st, false) && queryHit((row.t + " " + row.fn + " " + row.from + " " + row.city + " " + row.al + " " + row.tail).toLowerCase()));
      }
      if (tab === "lard") {
        return routings.filter((row) => {
          const code = mark(row.partner || carrier(row.outbound) || carrier(row.inbound));
          return code === (airline || code) && (!kind || row.equip === kind) && (!place || (row.outboundTo || row.inboundFrom) === place) && hoursOk(row.outboundIso || row.inboundIso) && matchStatus(row.outboundKind, true) && queryHit((row.tail + " " + row.inbound + " " + row.outbound + " " + row.outboundTo + " " + row.inboundFrom).toLowerCase());
        });
      }
      return flights.filter((row) => carrier(row.fn) === (airline || carrier(row.fn)) && (!kind || row.equip === kind) && (!place || row.to === place) && hoursOk(row.iso) && matchStatus(row.st, true) && queryHit((row.t + " " + row.fn + " " + row.to + " " + row.city + " " + row.al + " " + row.tail + " " + row.inbound).toLowerCase()));
    }
    function cell(html) { return "<td>" + html + "</td>"; }
    function draw() {
      const list = rows();
      const remaining = flights.filter((f) => f.st !== "Departed");
      const open = routings.filter((r) => r.outboundKind !== "Departed");
      $("title").textContent = tab === "arr" ? "Arrivals" : tab === "lard" ? "LARD" : "Departures";
      const pulled = new Date(DATA.pulled);
      const clock = pulled.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
      $("pulled").textContent = clock + " ET";
      $("blurb").textContent = (tab === "lard" ? open.length + " tails still here" : tab === "arr" ? arrivals.length + " arrivals" : remaining.length + " still to depart") + " · next 12 hours · pulled " + clock + " ET" + (DATA.note ? " · " + DATA.note : "");
      $("stats").innerHTML = [["departures", remaining.length], ["delayed", remaining.filter((f) => f.st === "Delayed").length], ["arrivals", arrivals.length]].map(([label, value]) => '<div class="stat"><b>' + value + "</b><span>" + label + "</span></div>").join("");
      for (const name of ["dep", "arr", "lard"]) $("tab-" + name).classList.toggle("on", tab === name);
      const heads = tab === "arr" ? ["When", "Flight", "From", "Tail", "EDCT", "Status"] : tab === "lard" ? ["Airline", "In", "From", "ETA", "Tail", "Out", "To", "ETD", "Gate"] : ["When", "Flight", "To", "Inbound", "Inbound ETA", "Status"];
      $("head").innerHTML = "<tr>" + heads.map((h) => "<th>" + h + "</th>").join("") + "</tr>";
      $("body").innerHTML = list.length ? list.map((row) => render(row)).join("") : '<tr><td colspan="' + heads.length + '">No flights in this filter.</td></tr>';
      drawMap(list);
    }
    function render(row) {
      if (tab === "arr") {
        const key = "arr|" + row.fn + "|" + row.t;
        return '<tr data-id="' + esc(key) + '" data-apt="' + esc(row.from) + '" data-into="1" class="' + (selected === key ? "on" : "") + '">' + cell(esc(row.date + " " + row.t) + '<div class="mute">ETA ' + esc(row.eta || row.t) + "</div>") + cell("<b>" + esc(row.fn) + '</b><div class="mute">' + esc(row.al) + "</div>") + cell("<b>" + esc(row.from) + "</b> " + esc(row.city) + (row.gate ? '<div class="mute">Gate ' + esc(row.gate) + "</div>" : "")) + cell("<b>" + esc(row.tail || "—") + "</b>") + cell("<b>" + esc((DATA.edcts || {})[row.fn + "|" + row.from] || "—") + "</b>") + cell(pill(row.st, row.detail)) + "</tr>";
      }
      if (tab === "lard") {
        const code = mark(row.partner || carrier(row.outbound) || carrier(row.inbound));
        const logo = code ? '<img class="logo' + (code === "UPS" ? " shield" : "") + '" alt="' + esc(code) + '" src="' + logoSrc(code) + '">' : "—";
        const gate = row.outboundGate && row.inboundGate && row.outboundGate !== row.inboundGate ? row.inboundGate + "/" + row.outboundGate : row.outboundGate || row.inboundGate || "—";
        return '<tr data-id="' + esc(row.id) + '" data-apt="' + esc(row.outboundTo || row.inboundFrom) + '" data-into="' + (row.outboundTo ? "0" : "1") + '" class="' + (selected === row.id ? "on" : "") + '">' + cell(logo) + cell("<b>" + esc(row.inbound || "—") + "</b>") + cell(esc(row.inboundFrom || "—")) + cell("<b>" + esc(row.eta || "—") + "</b>") + cell("<b>" + esc(row.tail || "—") + "</b>") + cell("<b>" + esc(row.outbound || "—") + "</b>") + cell(esc(row.outboundTo || "—")) + cell("<b>" + esc(row.etd || "—") + "</b>") + cell(esc(gate)) + "</tr>";
      }
      const key = row.fn + "|" + row.t;
      const inbound = row.inbound ? "<b>" + esc(row.inbound) + '</b><div class="mute">' + esc(row.tail || "—") + "</div>" : esc(row.tail || "—");
      const eta = (row.inboundEta || "").match(/(\\d{1,2}:\\d{2})/);
      return '<tr data-id="' + esc(key) + '" data-apt="' + esc(row.to) + '" data-into="0" class="' + (selected === key ? "on" : "") + '">' + cell(esc(row.date + " " + row.t) + '<div class="mute">ETD ' + esc(row.etd || row.t) + "</div>") + cell("<b>" + esc(row.fn) + '</b><div class="mute">' + esc(row.al) + "</div>") + cell("<b>" + esc(row.to) + "</b> " + esc(row.city) + (row.gate ? '<div class="mute">Gate ' + esc(row.gate) + "</div>" : "")) + cell(inbound) + cell(eta ? "<b>" + esc(eta[1]) + '</b><div class="mute">' + esc(row.inboundEtaKind || "") + "</div>" : "—") + cell(pill(row.st, row.detail)) + "</tr>";
    }
    let map, routes;
    function bootMap() {
      map = L.map("map", { zoomControl: false }).setView([40.8, -74], 4);
      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.tileLayer("https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=cb1_4b02_1_f58b8a12fcfccf5a56049c12", { attribution: "&copy; OpenStreetMap &copy; CARTO", maxZoom: 18 }).addTo(map);
      L.circleMarker(DATA.bos, { radius: 7, color: "#c4512c", fillColor: "#c4512c", fillOpacity: 1 }).addTo(map).bindPopup("<b>BOS</b> Boston");
      routes = L.layerGroup().addTo(map);
    }
    function arc(a, b) {
      const pts = [];
      for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        const lat = a[0] + (b[0] - a[0]) * t;
        const lon = a[1] + (b[1] - a[1]) * t;
        const lift = Math.sin(Math.PI * t) * Math.min(8, Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.15);
        pts.push([lat + lift, lon]);
      }
      return pts;
    }
    function selectedRow() {
      if (tab === "arr") return arrivals.find((item) => "arr|" + item.fn + "|" + item.t === selected) || null;
      if (tab === "lard") return routings.find((item) => item.id === selected) || null;
      return flights.find((item) => item.fn + "|" + item.t === selected) || null;
    }
    function drawMap(list) {
      if (!map) return;
      routes.clearLayers();
      const legs = [];
      for (const row of list) {
        const apt = tab === "arr" ? row.from : tab === "lard" ? row.outboundTo || row.inboundFrom : row.to;
        const id = tab === "arr" ? "arr|" + row.fn + "|" + row.t : tab === "lard" ? row.id : row.fn + "|" + row.t;
        if (apt) legs.push({ id, apt, into: tab === "arr" || (tab === "lard" && !row.outboundTo) });
      }
      const hot = selected ? legs.filter((leg) => leg.id === selected) : [];
      const drawn = (hot.length ? hot : legs).slice(0, 70);
      let bounds = null;
      for (const leg of drawn) {
        const place = DATA.places[leg.apt];
        if (!place) continue;
        const line = L.polyline(leg.into ? arc([place[1], place[2]], DATA.bos) : arc(DATA.bos, [place[1], place[2]]), { color: hot.length ? "#c4512c" : "#0e3a5d", weight: hot.length ? 3 : 1.2, opacity: hot.length ? 0.9 : 0.28 }).addTo(routes);
        bounds = bounds ? bounds.extend(line.getBounds()) : line.getBounds();
      }
      const row = selected ? selectedRow() : null;
      const airborne = row && row.tail && row.st !== "Landed" && row.st !== "Cancelled" && (row.live || row.st === "Departed" || row.st === "Estimated" || row.outboundKind === "Departed");
      if (row && row.plan && row.plan.a && row.plan.b) {
        const route = L.polyline(arc(row.plan.a, row.plan.b), { color: "#14202b", weight: 3, opacity: 0.9, dashArray: "7 6" }).addTo(routes);
        L.circleMarker(row.plan.a, { radius: 4, color: "#14202b", fillColor: "#f4efe4", fillOpacity: 1, weight: 2 }).addTo(routes).bindTooltip(row.plan.from || "Origin", { permanent: true, direction: "right", className: "plan-tag" });
        L.circleMarker(row.plan.b, { radius: 4, color: "#14202b", fillColor: "#f4efe4", fillOpacity: 1, weight: 2 }).addTo(routes).bindTooltip(row.plan.to || "Destination", { permanent: true, direction: "left", className: "plan-tag" });
        bounds = bounds ? bounds.extend(route.getBounds()) : route.getBounds();
      }
      if (row && row.fix) {
        const label = (row.fn || row.outbound || row.inbound || "Aircraft") + " " + (row.tail || "") + (row.fix.alt ? " · " + row.fix.alt : "");
        const plan = row.plan ? row.plan.from + "–" + row.plan.to : "";
        const icon = L.divIcon({
          className: "plane-pin",
          html: '<svg width="28" height="28" viewBox="0 0 28 28" style="transform:rotate(' + (Number(row.fix.track) || 0) + 'deg)"><path d="M14 1.5 L16.2 10.5 L26 13.2 L16.2 15 L15.2 22 L18 26 L14 23.2 L10 26 L12.8 22 L11.8 15 L2 13.2 L11.8 10.5 Z" fill="#14202b" stroke="#c4512c" stroke-width="1.2" stroke-linejoin="round"/></svg>',
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        });
        L.marker([row.fix.lat, row.fix.lon], { icon, zIndexOffset: 800 }).addTo(routes).bindPopup("<b>" + esc(label) + "</b>" + (plan ? "<div>Flight plan " + esc(plan) + "</div>" : "") + "<div>ADS-B from the last pull</div>");
        const spot = L.latLng(row.fix.lat, row.fix.lon);
        bounds = bounds ? bounds.extend(spot) : L.latLngBounds(spot, spot);
      }
      const note = $("pull-note");
      if (airborne && row && !row.fix && note && !note.textContent.startsWith("Pull")) note.textContent = "No current ADS-B position for " + row.tail + ".";
      if (bounds && bounds.isValid()) map.fitBounds(bounds.pad(0.2), { maxZoom: selected && row && row.fix ? 6 : 5 });
    }
    async function pullNow() {
      const button = $("pull");
      const note = $("pull-note");
      const runPage = window.open("https://github.com/pdirubbo/boston-logan-flight-board/actions/workflows/pages.yml", "_blank", "noopener");
      button.disabled = true;
      button.textContent = "Pulling…";
      note.innerHTML = 'Confirm <a href="https://github.com/pdirubbo/boston-logan-flight-board/actions/workflows/pages.yml" target="_blank" rel="noopener">Run workflow</a> on GitHub. This board reloads when the new schedule is up.';
      let before = "";
      try {
        const head = await fetch("https://api.github.com/repos/pdirubbo/boston-logan-flight-board/commits/gh-pages", { headers: { Accept: "application/vnd.github+json" } });
        const json = await head.json();
        before = json.sha || "";
      } catch (error) {
        before = "";
      }
      const started = Date.now();
      const timer = setInterval(async () => {
        if (Date.now() - started > 8 * 60 * 1000) {
          clearInterval(timer);
          note.textContent = "The pull is taking longer than usual. The last board is still up.";
          button.disabled = false;
          button.textContent = "Pull now";
          return;
        }
        try {
          const head = await fetch("https://api.github.com/repos/pdirubbo/boston-logan-flight-board/commits/gh-pages?t=" + Date.now(), { headers: { Accept: "application/vnd.github+json" } });
          const json = await head.json();
          if (json.sha && before && json.sha !== before) {
            clearInterval(timer);
            location.reload();
          }
        } catch (error) {}
      }, 15000);
      try {
        const response = await fetch("https://api.github.com/repos/pdirubbo/boston-logan-flight-board/actions/workflows/pages.yml/dispatches", {
          method: "POST",
          headers: { Accept: "application/vnd.github+json", "Content-Type": "application/json" },
          body: JSON.stringify({ ref: "main" }),
        });
        if (response.status === 204) {
          if (runPage) runPage.close();
          note.textContent = "Pulling the live schedule. This page will reload when it is ready.";
        }
      } catch (error) {}
    }
    function setTab(next) { tab = next; selected = ""; choices(); draw(); }
    $("tab-dep").onclick = () => setTab("dep");
    $("tab-arr").onclick = () => setTab("arr");
    $("tab-lard").onclick = () => setTab("lard");
    $("pull").onclick = () => void pullNow();
    for (const id of ["q", "status", "airline", "span", "equip", "place"]) $(id).addEventListener("input", draw);
    $("body").addEventListener("click", (event) => {
      const tr = event.target.closest("tr");
      if (!tr) return;
      selected = tr.dataset.id || "";
      draw();
    });
    document.body.addEventListener("error", (event) => {
      const img = event.target;
      if (!img || !img.classList || !img.classList.contains("logo")) return;
      const mark = document.createElement("b");
      mark.textContent = img.alt;
      img.replaceWith(mark);
    }, true);
    choices();
    bootMap();
    draw();
    setInterval(() => location.reload(), 10 * 60 * 1000);
  </script>
</body>
</html>
`;

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "index.html"), html);
writeFileSync(join(outDir, ".nojekyll"), "");
console.log(`Wrote ${outDir}/index.html with ${data.flights.length} departures, ${(data.arrivals ?? []).length} arrivals.`);
