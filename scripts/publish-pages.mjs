import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "site");

const { AIRPORTS, BOS } = await import("../src/lib/flights.ts");

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
    footer { padding: 8px 24px 16px; color: var(--mute); font-size: 12px; }
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
      </div>
      <div class="scroll"><table><thead id="head"></thead><tbody id="body"></tbody></table></div>
    </section>
  </div>
  <footer>Refreshed from the live schedule every 10 minutes. This copy was pulled <span id="pulled"></span>.</footer>
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
    const carrier = (fn) => (String(fn || "").toUpperCase().match(/^([A-Z0-9]{2})\\d/) || [])[1] || "";
    const pill = (st, detail) => {
      const kind = /cancel|delay|divert/i.test(st) ? "bad" : /depart|land|on time|airborne/i.test(st) ? "good" : "wait";
      return '<span class="pill ' + kind + '">' + esc(detail || st || "—") + "</span>";
    };
    const esc = (s) => String(s ?? "").replace(/&/g, "&\u0061mp;").replace(/</g, "&\u006ct;").replace(/>/g, "&\u0067t;").replace(/"/g, "&\u0071uot;");
    const flights = (DATA.flights || []).filter((f) => within(f.iso));
    const arrivals = (DATA.arrivals || []).filter((f) => within(f.iso));
    const routings = (DATA.routings || []).filter((f) => within(f.outboundIso || f.inboundIso));
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
        const code = tab === "lard" ? row.partner || carrier(row.outbound) || carrier(row.inbound) : carrier(row.fn);
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
          const code = row.partner || carrier(row.outbound) || carrier(row.inbound);
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
        const code = row.partner || carrier(row.outbound) || carrier(row.inbound);
        const logo = code ? '<img class="logo" alt="' + esc(code) + '" src="https://pics.avs.io/120/36/' + esc(code) + '.png">' : "—";
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
      if (bounds && bounds.isValid()) map.fitBounds(bounds.pad(0.2), { maxZoom: 5 });
    }
    function setTab(next) { tab = next; selected = ""; choices(); draw(); }
    $("tab-dep").onclick = () => setTab("dep");
    $("tab-arr").onclick = () => setTab("arr");
    $("tab-lard").onclick = () => setTab("lard");
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
