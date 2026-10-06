export type FlightStatus =
  | "Scheduled"
  | "On time"
  | "Delayed"
  | "Estimated"
  | "Departed"
  | "Landed"
  | "Cancelled"
  | "Diverted"
  | "Airborne";

export type Flight = {
  date: string;
  t: string;
  iso: string;
  to: string;
  city: string;
  fn: string;
  al: string;
  st: Exclude<FlightStatus, "Airborne">;
  detail: string;
  gate: string;
  inbound: string;
  inboundFrom: string;
  inboundEta: string;
  inboundGate: string;
  inboundStatus: string;
  inboundOp: string;
  inboundEdct: string;
  inboundEtaKind: "" | "Published" | "ETA" | "Arrived";
  tail: string;
  etd: string;
  equip: string;
};

export type Arrival = {
  date: string;
  t: string;
  iso: string;
  from: string;
  city: string;
  fn: string;
  al: string;
  st: Exclude<FlightStatus, "Airborne">;
  detail: string;
  tail: string;
  gate: string;
  op: string;
  eta: string;
  live: boolean;
  equip: string;
};

export type Routing = {
  id: string;
  tail: string;
  inbound: string;
  inboundFrom: string;
  inboundWhen: string;
  inboundIso: string;
  inboundGate: string;
  inboundStatus: string;
  inboundKind: Flight["st"] | "";
  outbound: string;
  outboundTo: string;
  outboundCity: string;
  outboundWhen: string;
  outboundIso: string;
  outboundGate: string;
  outboundStatus: string;
  outboundKind: Flight["st"] | "";
  toa: string;
  eta: string;
  tod: string;
  etd: string;
  partner: string;
  sort: string;
  equip: string;
};

export type Program = {
  airport: string;
  reason: string;
  avg: string;
};

export type Snapshot = {
  pulled: string;
  count: number;
  note: string;
  airport: "BOS";
  airportName: string;
  gdp: Program | null;
  flights: Flight[];
  arrivals: Arrival[];
  routings: Routing[];
  edcts: Record<string, string>;
};

export const BOARDS = {
  BOS: { code: "BOS" as const, name: "Boston Logan", city: "Boston" },
};

export const BOS: [number, number] = [42.3656, -71.0096];

export const AIRPORTS: Record<string, [string, number, number]> = {
  ABQ: ["Albuquerque", 35.04, -106.609],
  ACK: ["Nantucket", 41.253, -70.06],
  ALB: ["Albany", 42.748, -73.802],
  AMS: ["Amsterdam", 52.31, 4.768],
  ATL: ["Atlanta", 33.64, -84.428],
  AUG: ["Augusta", 44.32, -69.797],
  AUA: ["Aruba", 12.501, -70.015],
  AUH: ["Abu Dhabi", 24.433, 54.651],
  AUS: ["Austin", 30.194, -97.67],
  BDA: ["Bermuda", 32.364, -64.679],
  BDL: ["Hartford", 41.929, -72.683],
  BGR: ["Bangor", 44.807, -68.828],
  BHB: ["Bar Harbor", 44.45, -68.362],
  BNA: ["Nashville", 36.126, -86.677],
  BOS: ["Boston", 42.366, -71.01],
  BTV: ["Burlington", 44.472, -73.153],
  BUF: ["Buffalo", 42.94, -78.732],
  BWI: ["Baltimore", 39.175, -76.668],
  CDG: ["Paris", 49.013, 2.55],
  CHS: ["Charleston", 32.899, -80.041],
  CLE: ["Cleveland", 41.412, -81.85],
  CLT: ["Charlotte", 35.214, -80.943],
  CMH: ["Columbus", 39.998, -82.892],
  CUN: ["Cancun", 21.037, -86.877],
  CVG: ["Cincinnati", 39.048, -84.668],
  DCA: ["Washington", 38.852, -77.037],
  DEN: ["Denver", 39.856, -104.674],
  DFW: ["Dallas", 32.9, -97.04],
  DTW: ["Detroit", 42.212, -83.353],
  DUB: ["Dublin", 53.421, -6.27],
  EWR: ["Newark", 40.69, -74.174],
  FCO: ["Rome", 41.8, 12.239],
  FLL: ["Fort Lauderdale", 26.072, -80.153],
  FRA: ["Frankfurt", 50.037, 8.562],
  GSO: ["Greensboro", 36.098, -79.937],
  HNL: ["Honolulu", 21.319, -157.922],
  HYA: ["Hyannis", 41.669, -70.28],
  IAD: ["Dulles", 38.944, -77.456],
  IAH: ["Houston", 29.984, -95.341],
  IND: ["Indianapolis", 39.717, -86.294],
  ISP: ["Islip", 40.795, -73.1],
  JAX: ["Jacksonville", 30.494, -81.688],
  JFK: ["New York JFK", 40.64, -73.779],
  LAS: ["Las Vegas", 36.08, -115.153],
  LAX: ["Los Angeles", 33.942, -118.408],
  LEB: ["Lebanon", 43.626, -72.304],
  LGA: ["New York LGA", 40.777, -73.873],
  LHR: ["London", 51.47, -0.454],
  LIS: ["Lisbon", 38.774, -9.134],
  MBJ: ["Montego Bay", 18.504, -77.913],
  MCI: ["Kansas City", 39.298, -94.714],
  MCO: ["Orlando", 28.429, -81.309],
  MDW: ["Chicago Midway", 41.786, -87.752],
  MHT: ["Manchester", 42.933, -71.436],
  MIA: ["Miami", 25.796, -80.287],
  MKE: ["Milwaukee", 42.947, -87.896],
  MSP: ["Minneapolis", 44.882, -93.222],
  MSY: ["New Orleans", 29.993, -90.258],
  MVY: ["Martha's Vineyard", 41.393, -70.614],
  NAS: ["Nassau", 25.039, -77.466],
  ORD: ["Chicago", 41.974, -87.907],
  ORF: ["Norfolk", 36.895, -76.201],
  ORH: ["Worcester", 42.267, -71.876],
  PBI: ["West Palm Beach", 26.683, -80.096],
  PDX: ["Portland", 45.589, -122.597],
  PHL: ["Philadelphia", 39.872, -75.241],
  PHX: ["Phoenix", 33.434, -112.012],
  PIT: ["Pittsburgh", 40.492, -80.233],
  PVD: ["Providence", 41.724, -71.428],
  PUJ: ["Punta Cana", 18.567, -68.363],
  PVC: ["Provincetown", 42.072, -70.221],
  PWM: ["Portland ME", 43.646, -70.309],
  RDU: ["Raleigh", 35.878, -78.788],
  RIC: ["Richmond", 37.505, -77.32],
  RKD: ["Rockland", 44.06, -69.099],
  ROC: ["Rochester", 43.119, -77.672],
  RSW: ["Fort Myers", 26.536, -81.755],
  SAN: ["San Diego", 32.734, -117.19],
  SAT: ["San Antonio", 29.534, -98.47],
  SAV: ["Savannah", 32.127, -81.202],
  SEA: ["Seattle", 47.449, -122.309],
  SFO: ["San Francisco", 37.619, -122.375],
  SLK: ["Saranac Lake", 44.385, -74.206],
  SJU: ["San Juan", 18.439, -66.002],
  SLC: ["Salt Lake City", 40.788, -111.978],
  STL: ["St. Louis", 38.749, -90.37],
  SXM: ["St. Maarten", 18.041, -63.109],
  SYR: ["Syracuse", 43.111, -76.106],
  TPA: ["Tampa", 27.975, -82.533],
  YHZ: ["Halifax", 44.881, -63.509],
  YUL: ["Montreal", 45.471, -73.741],
  YYZ: ["Toronto", 43.677, -79.625],
  YTZ: ["Toronto City", 43.627, -79.396],
};

const PREFIX: Record<string, string> = {
  B6: "JBU",
  DL: "DAL",
  UA: "UAL",
  AA: "AAL",
  WN: "SWA",
  AS: "ASA",
  AC: "ACA",
  PD: "POE",
  EY: "ETD",
  AV: "AVA",
  BA: "BAW",
  LH: "DLH",
  AF: "AFR",
  KL: "KLM",
  IB: "IBE",
  EI: "EIN",
  TP: "TAP",
  SK: "SAS",
  AY: "FIN",
  LX: "SWR",
  OS: "AUA",
  TK: "THY",
  EK: "UAE",
  QR: "QTR",
  VS: "VIR",
  FI: "ICE",
  CM: "CMP",
  AM: "AMX",
  LA: "LAN",
  KE: "KAL",
  NH: "ANA",
  JL: "JAL",
  CX: "CPA",
  QF: "QFA",
  YX: "RPA",
  MQ: "ENY",
  OO: "SKW",
  "9E": "EDV",
  QX: "QXE",
  OH: "JIA",
  YV: "ASH",
  G7: "GJS",
  PT: "PDT",
  ZW: "AWI",
  C5: "UCA",
  QK: "JZA",
  "9K": "KAP",
  G4: "AAY",
  NK: "NKS",
  F9: "FFT",
  SY: "SCX",
  "5X": "UPS",
  WS: "WJA",
  TS: "TSC",
};

export function airlineCode(code: string): string {
  const value = code.toUpperCase();
  return value === "5X" ? "UPS" : value;
}

export function iataFlight(ident: string): string {
  const raw = ident.toUpperCase().replace(/\s+/g, "");
  const match = raw.match(/^([A-Z0-9]{2,3})(\d+)$/);
  if (!match) return raw;
  if (match[1].length === 2) return match[1] + String(parseInt(match[2], 10));
  const iata = Object.entries(PREFIX).find(([, icao]) => icao === match[1])?.[0];
  return (iata ?? match[1]) + String(parseInt(match[2], 10));
}

export function callsign(fn: string): string {
  const m = fn.toUpperCase().match(/^([A-Z0-9]{2})(\d+)$/);
  if (!m) return "";
  return (PREFIX[m[1]] ?? m[1]) + String(parseInt(m[2], 10));
}

export function airlineFamily(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("delta") || n.includes("republic") || n.includes("endeavor")) return "delta";
  if (n.includes("jetblue") || n.includes("jet blue")) return "jetblue";
  if (n.includes("american") || n.includes("envoy")) return "american";
  if (n.includes("united") || n.includes("skywest")) return "united";
  if (n.includes("cape")) return "cape";
  if (n.includes("southwest")) return "southwest";
  if (n.includes("alaska") || n.includes("horizon")) return "alaska";
  if (n.includes("porter")) return "porter";
  if (n.includes("air canada")) return "aircanada";
  if (n.includes("spirit")) return "spirit";
  if (n.includes("frontier")) return "frontier";
  return n.split(" ")[0] ?? "";
}

export function isNorthAmerica(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  const airport = AIRPORTS[code];
  if (!airport) return true;
  const lat = airport[1];
  const lon = airport[2];
  return lat >= 7 && lat <= 84 && lon <= -50 && lon >= -170;
}

export function hasClock(edct: string): boolean {
  return /^\d{1,2}:\d{2}/.test(edct) || /^\d{4}Z/.test(edct);
}

export function gc(a: [number, number], b: [number, number], n = 32): [number, number][] {
  const rad = (d: number) => (d * Math.PI) / 180;
  const deg = (r: number) => (r * 180) / Math.PI;
  const lat1 = rad(a[0]);
  const lon1 = rad(a[1]);
  const lat2 = rad(b[0]);
  const lon2 = rad(b[1]);
  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((lat2 - lat1) / 2) ** 2 +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2,
      ),
    );
  if (!d) return [a, b];
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    pts.push([deg(Math.atan2(z, Math.sqrt(x * x + y * y))), deg(Math.atan2(y, x))]);
  }
  return pts;
}
