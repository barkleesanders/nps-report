// Park mailbox registry.
//
// Maps a park code (e.g. "goga") to the obfuscated `o=` recipient token its
// "Email Us" form uses. Tokens are stable per mailbox; regenerate/extend the
// backing JSON with `npm run harvest`.

import parksData from "./parks.data.json";

export interface Park {
  /** NPS park code, e.g. "goga", "yose", "grca". */
  code: string;
  /** Human-readable park name. */
  name: string;
  /** Referrer path for the contact form, e.g. "/goga/contacts.htm". */
  referrerPath: string;
  /** Obfuscated `o=` recipient token (the park mailbox). */
  recipientToken: string;
  /** Which mailbox this is (general/info/superintendent/…). */
  mailbox?: string;
  /** State abbreviations the park spans. */
  states?: string[];
  /** Representative latitude (for nearest-park resolution). */
  lat?: number;
  /** Representative longitude. */
  lng?: number;
}

const PARKS: Park[] = (parksData as { parks: Park[] }).parks;
const BY_CODE = new Map(PARKS.map((p) => [p.code.toLowerCase(), p]));

/**
 * The `_meta.verified` stamp in parks.data.json is a **harvest date, not a
 * health claim** — it records when the tokens were last scraped, and says
 * nothing about whether they still open a working form today. Live health is
 * answered by the weekly consumer-path sweep in `registry-health.ts`
 * (`GET /api/registry/health`), never by reading this date.
 */
export function registryHarvestedAt(): string {
  return (parksData as { _meta?: { verified?: string } })._meta?.verified ?? "unknown";
}

/**
 * Parks that legitimately have NO coordinates, with the reason each one is
 * exempt. Both are multi-site units — a set of scattered buildings and a
 * cross-state trail route — that publish no Point centroid upstream, verified
 * against the live central.nps.gov feed on 2026-08-10.
 *
 * This list exists so the completeness invariant in `parks.test.ts` can fail on
 * a NEW coordinate-less park while staying green on these two. Deleting an
 * entry here is how you re-open the question; adding one requires checking the
 * upstream feed first, because the last "missing" park (`cave`, Carlsbad
 * Caverns) was not missing at all — it is listed upstream under `CACA` with
 * `codes: ["CACA","CAVE"]`, and the harvester's primary-key-only lookup simply
 * never found it.
 */
export const COORDINATES_EXEMPT: Readonly<Record<string, string>> = Object.freeze({
  masi: "Manhattan Sites — scattered NYC sites, no single Point centroid upstream",
  neje: "New Jersey Coastal Heritage Trail Route — a multi-county route, not a point",
});

export function listParks(): Park[] {
  return PARKS;
}

export interface RegistryDefect {
  code: string;
  field: string;
  detail: string;
}

/**
 * Structural invariants every registry entry must satisfy for the app to work:
 * a mailbox token (or the park can never be emailed) and coordinates (or the
 * park can never be reached by GPS). Returns every defect, not the first.
 *
 * A park with no coordinates is not a crash — `nearestPark` skips it silently —
 * which is exactly why this needs a gate rather than a runtime check.
 */
export function registryDefects(parks: Park[] = PARKS): RegistryDefect[] {
  const defects: RegistryDefect[] = [];
  const seen = new Set<string>();
  for (const p of parks) {
    const code = p.code ?? "(missing code)";
    if (!p.code?.trim()) defects.push({ code, field: "code", detail: "empty" });
    if (!p.name?.trim()) defects.push({ code, field: "name", detail: "empty" });
    if (!p.referrerPath?.startsWith("/")) {
      defects.push({ code, field: "referrerPath", detail: `not a path: ${p.referrerPath}` });
    }
    if (!p.recipientToken?.trim()) {
      defects.push({ code, field: "recipientToken", detail: "empty — park is unreachable" });
    }
    if (seen.has(code.toLowerCase())) {
      defects.push({ code, field: "code", detail: "duplicate" });
    }
    seen.add(code.toLowerCase());

    const hasCoords =
      typeof p.lat === "number" &&
      typeof p.lng === "number" &&
      Number.isFinite(p.lat) &&
      Number.isFinite(p.lng) &&
      p.lat >= -90 &&
      p.lat <= 90 &&
      p.lng >= -180 &&
      p.lng <= 180 &&
      !(p.lat === 0 && p.lng === 0);
    if (!hasCoords && !(code.toLowerCase() in COORDINATES_EXEMPT)) {
      defects.push({
        code,
        field: "lat/lng",
        detail: "no usable coordinates — GPS can never select this park",
      });
    }
  }
  return defects;
}

export function getPark(code: string): Park | undefined {
  return BY_CODE.get(code.trim().toLowerCase());
}

/** Public-safe park summary (omits the raw recipient token). */
export function publicPark(p: Park): Omit<Park, "recipientToken"> & { hasMailbox: boolean } {
  const { recipientToken, ...rest } = p;
  return { ...rest, hasMailbox: Boolean(recipientToken) };
}
