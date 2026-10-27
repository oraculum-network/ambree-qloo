// Distances on the Earth, for keeping a day in one region (plan_day and the demo transport).

export interface Point {
  lat: number;
  lon: number;
}

/** Kilometres between two points (haversine). */
export function distanceKm(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The point in a WKT "POINT(lon lat)", as Qloo's filter.location takes it. */
export function parsePoint(wkt: string | undefined): Point | undefined {
  const m = /^POINT\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/i.exec(wkt ?? "");
  return m ? { lon: Number(m[1]), lat: Number(m[2]) } : undefined;
}
