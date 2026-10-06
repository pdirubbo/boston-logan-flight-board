import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";
import { AIRPORTS, BOS, gc } from "@/lib/flights";

export type MapLeg = {
  id: string;
  airport: string;
  into: boolean;
};

export type Craft = { lat: number; lon: number; label: string };

type Props = {
  legs: MapLeg[];
  selected: string;
  craft?: Craft | null;
  home?: [number, number];
  code?: string;
  place?: string;
};

export function LoganMap({ legs, selected, craft = null, home = BOS, code = "BOS", place = "Logan" }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const routesRef = useRef<import("leaflet").LayerGroup | null>(null);
  const fitted = useRef("");

  useEffect(() => {
    let dead = false;
    const node = host.current;
    if (!node) return;
    (async () => {
      const leaflet = await import("leaflet");
      if (dead || !host.current || mapRef.current) return;
      const L = leaflet.default;
      const map = L.map(host.current, { worldCopyJump: true, zoomControl: false }).setView([40.8, -74], 5);
      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.tileLayer(
        "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=cb1_4b02_1_f58b8a12fcfccf5a56049c12",
        {
          attribution: "&copy; OpenStreetMap &copy; CARTO",
          maxZoom: 18,
        },
      ).addTo(map);
      L.circleMarker(home, { radius: 7, color: "#c4512c", fillColor: "#c4512c", fillOpacity: 1 })
        .addTo(map)
        .bindPopup(`<b>${code}</b> ${place}`);
      routesRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;
      requestAnimationFrame(() => map.invalidateSize());
    })();
    return () => {
      dead = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const routes = routesRef.current;
    if (!map || !routes) return;
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled) return;
      routes.clearLayers();
      const hot = selected
        ? legs.filter((leg) => leg.id === selected || leg.id.startsWith(`${selected}|`))
        : [];
      const drawn = hot.length ? hot : legs.filter((leg) => AIRPORTS[leg.airport]).slice(0, 70);
      let focus: import("leaflet").LatLngBounds | null = null;
      for (const leg of drawn) {
        const place = AIRPORTS[leg.airport];
        if (!place) continue;
        const line = L.polyline(leg.into ? gc([place[1], place[2]], home) : gc(home, [place[1], place[2]]), {
          color: hot.length ? "#c4512c" : "#0e3a5d",
          weight: hot.length ? 3 : 1.2,
          opacity: hot.length ? 0.9 : 0.28,
        }).addTo(routes);
        focus = focus ? focus.extend(line.getBounds()) : line.getBounds();
      }
      if (craft) {
        L.circleMarker([craft.lat, craft.lon], {
          radius: 8,
          color: "#c4512c",
          weight: 3,
          fillColor: "#14202b",
          fillOpacity: 1,
        })
          .addTo(routes)
          .bindPopup(`<b>${craft.label.replace(/[&<>]/g, "")}</b>`);
        const spot = L.latLng(craft.lat, craft.lon);
        focus = focus ? focus.extend(spot) : L.latLngBounds(spot, spot);
      }
      const fitKey = `${selected}|${craft?.lat ?? ""}|${craft?.lon ?? ""}`;
      if ((hot.length || craft) && focus && fitted.current !== fitKey) {
        fitted.current = fitKey;
        map.fitBounds(focus.pad(0.35));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [craft, home, legs, selected]);

  return <div ref={host} className="h-full w-full" />;
}