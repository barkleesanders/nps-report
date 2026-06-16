// Location helpers.
//
// NPS reports have NO structured geo field, so coordinates must be embedded in
// the free-text message. These helpers also resolve a lat/lng to the nearest
// registered park, so an app can capture a photo + GPS (like improvebayarea) and
// auto-route the report to the right park mailbox.

import { listParks, type Park } from "./parks";

export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Nearest registered park to a coordinate (only parks with lat/lng). */
export function nearestPark(lat: number, lng: number): { park: Park; distanceKm: number } | null {
  let best: { park: Park; distanceKm: number } | null = null;
  for (const park of listParks()) {
    if (typeof park.lat !== "number" || typeof park.lng !== "number") continue;
    const distanceKm = haversineKm({ lat, lng }, { lat: park.lat, lng: park.lng });
    if (!best || distanceKm < best.distanceKm) best = { park, distanceKm };
  }
  return best;
}

export function mapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

/** A human-readable coordinate line for embedding in the report body. */
export function locationLine(lat: number, lng: number, label?: string): string {
  const coords = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  const link = mapsUrl(lat, lng);
  return label ? `${label} (${coords}) — ${link}` : `Coordinates: ${coords} — ${link}`;
}

export function isValidLatLng(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}
