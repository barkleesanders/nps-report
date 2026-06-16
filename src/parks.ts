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

export function listParks(): Park[] {
  return PARKS;
}

export function getPark(code: string): Park | undefined {
  return BY_CODE.get(code.trim().toLowerCase());
}

/** Public-safe park summary (omits the raw recipient token). */
export function publicPark(p: Park): Omit<Park, "recipientToken"> & { hasMailbox: boolean } {
  const { recipientToken, ...rest } = p;
  return { ...rest, hasMailbox: Boolean(recipientToken) };
}
