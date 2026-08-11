// EXIF reader — pulls the photo's OWN provenance (where and when it was taken)
// out of the JPEG the user uploaded.
//
// WHY THIS EXISTS
// ---------------
// Park selection used to come from `navigator.geolocation` — the phone's
// position *at submit time*. National parks have no signal, so the normal flow
// is: photograph the broken railing on the trail, drive out, submit that
// evening from the hotel. The report then routes to whatever park is nearest
// the HOTEL, confidently and silently. The photo already carries where it was
// taken; ambient GPS is a proxy for it, and a bad one.
//
// SHIPPING NOTE — one source of truth for the browser copy
// --------------------------------------------------------
// `readExifGps` and `readExifTakenAt` are ALSO executed in the browser. `ui.ts`
// embeds them via `Function.prototype.toString()` rather than keeping a second
// hand-written copy inside the page's template literal. Code inside a template
// literal is invisible to tsc, biome and vitest — a syntax error there ships
// with every gate green. Serialising the real, unit-tested function means the
// exact text the browser runs is the exact text the tests ran.
//
// That imposes one hard constraint, enforced by `exif.test.ts`:
// **these two functions must be entirely self-contained** — no imports, no
// module-scope constants, no closure captures, no other-function calls. If you
// reference anything outside the function body, `.toString()` ships a
// ReferenceError to every visitor and nothing in the build will tell you.

export interface ExifGps {
  lat: number;
  lng: number;
}

/**
 * Extract GPS coordinates from a JPEG's EXIF block. Returns null when the file
 * is not a JPEG, carries no EXIF, or has no GPS tags (most screenshots, most
 * images stripped by messaging apps, and any photo taken with location off).
 *
 * SELF-CONTAINED — see the module header before editing.
 */
export function readExifGps(bytes: Uint8Array): ExifGps | null {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null; // not a JPEG (no SOI)

  // Local accessor: the file may be truncated at any offset, and every read
  // below is already bounds-checked, so an out-of-range byte reads as 0 rather
  // than widening every expression to `number | undefined`. Declared INSIDE the
  // function so the browser copy stays self-contained (see module header).
  const b = (i: number): number => bytes[i] ?? 0;

  // --- locate the APP1/Exif segment -> TIFF header offset ---
  let p = 2;
  let tiff = -1;
  while (p + 4 <= bytes.length) {
    if (b(p) !== 0xff) {
      p++;
      continue;
    }
    const marker = b(p + 1);
    if (marker === 0xff) {
      p++;
      continue;
    } // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end of image
    const size = (b(p + 2) << 8) | b(p + 3);
    if (size < 2) break;
    if (
      marker === 0xe1 &&
      p + 10 <= bytes.length &&
      b(p + 4) === 0x45 && // E
      b(p + 5) === 0x78 && // x
      b(p + 6) === 0x69 && // i
      b(p + 7) === 0x66 && // f
      b(p + 8) === 0x00
    ) {
      tiff = p + 10;
      break;
    }
    p += 2 + size;
  }
  if (tiff < 0 || tiff + 8 > bytes.length) return null;

  const little = b(tiff) === 0x49 && b(tiff + 1) === 0x49;
  const big = b(tiff) === 0x4d && b(tiff + 1) === 0x4d;
  if (!little && !big) return null;

  const u16 = (at: number): number =>
    little ? b(at) | (b(at + 1) << 8) : (b(at) << 8) | b(at + 1);
  const u32 = (at: number): number =>
    (little
      ? b(at) | (b(at + 1) << 8) | (b(at + 2) << 16) | (b(at + 3) << 24)
      : (b(at) << 24) | (b(at + 1) << 16) | (b(at + 2) << 8) | b(at + 3)) >>> 0;

  if (u16(tiff + 2) !== 0x002a) return null; // TIFF magic
  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 + 2 > bytes.length) return null;

  // --- find the GPS IFD pointer (tag 0x8825) in IFD0 ---
  let gpsIfd = -1;
  const n0 = u16(ifd0);
  for (let i = 0; i < n0; i++) {
    const e = ifd0 + 2 + i * 12;
    if (e + 12 > bytes.length) break;
    if (u16(e) === 0x8825) {
      gpsIfd = tiff + u32(e + 8);
      break;
    }
  }
  if (gpsIfd < 0 || gpsIfd + 2 > bytes.length) return null;

  // --- read the four GPS tags we need ---
  let latRef = "";
  let lngRef = "";
  let lat: number | null = null;
  let lng: number | null = null;

  const dms = (valueOffset: number, count: number): number | null => {
    // 3 RATIONALs (degrees, minutes, seconds), each 8 bytes: num/den.
    if (count < 3) return null;
    const base = tiff + valueOffset;
    if (base + 24 > bytes.length) return null;
    let total = 0;
    for (let k = 0; k < 3; k++) {
      const num = u32(base + k * 8);
      const den = u32(base + k * 8 + 4);
      if (den === 0) return null;
      total += num / den / (k === 0 ? 1 : k === 1 ? 60 : 3600);
    }
    return total;
  };

  const nG = u16(gpsIfd);
  for (let i = 0; i < nG; i++) {
    const e = gpsIfd + 2 + i * 12;
    if (e + 12 > bytes.length) break;
    const tag = u16(e);
    const count = u32(e + 4);
    if (tag === 1) latRef = String.fromCharCode(b(e + 8));
    else if (tag === 3) lngRef = String.fromCharCode(b(e + 8));
    else if (tag === 2) lat = dms(u32(e + 8), count);
    else if (tag === 4) lng = dms(u32(e + 8), count);
  }

  if (lat === null || lng === null) return null;
  if (latRef === "S") lat = -lat;
  if (lngRef === "W") lng = -lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  // 0,0 is Null Island — overwhelmingly a zeroed/placeholder tag, not a photo
  // taken in the Gulf of Guinea. Treat it as absent.
  if (lat === 0 && lng === 0) return null;
  return { lat: lat, lng: lng };
}

/**
 * Extract DateTimeOriginal ("when the shutter fired") as an ISO-like local
 * string, e.g. "2026-08-09 14:32:07". EXIF stores no timezone, so this is
 * deliberately NOT converted to UTC — it is reported verbatim as local park
 * time, which is what a ranger reading the email wants.
 *
 * SELF-CONTAINED — see the module header before editing.
 */
export function readExifTakenAt(bytes: Uint8Array): string | null {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  // Local accessor: the file may be truncated at any offset, and every read
  // below is already bounds-checked, so an out-of-range byte reads as 0 rather
  // than widening every expression to `number | undefined`. Declared INSIDE the
  // function so the browser copy stays self-contained (see module header).
  const b = (i: number): number => bytes[i] ?? 0;

  let p = 2;
  let tiff = -1;
  while (p + 4 <= bytes.length) {
    if (b(p) !== 0xff) {
      p++;
      continue;
    }
    const marker = b(p + 1);
    if (marker === 0xff) {
      p++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    const size = (b(p + 2) << 8) | b(p + 3);
    if (size < 2) break;
    if (
      marker === 0xe1 &&
      p + 10 <= bytes.length &&
      b(p + 4) === 0x45 &&
      b(p + 5) === 0x78 &&
      b(p + 6) === 0x69 &&
      b(p + 7) === 0x66 &&
      b(p + 8) === 0x00
    ) {
      tiff = p + 10;
      break;
    }
    p += 2 + size;
  }
  if (tiff < 0 || tiff + 8 > bytes.length) return null;

  const little = b(tiff) === 0x49 && b(tiff + 1) === 0x49;
  const big = b(tiff) === 0x4d && b(tiff + 1) === 0x4d;
  if (!little && !big) return null;

  const u16 = (at: number): number =>
    little ? b(at) | (b(at + 1) << 8) : (b(at) << 8) | b(at + 1);
  const u32 = (at: number): number =>
    (little
      ? b(at) | (b(at + 1) << 8) | (b(at + 2) << 16) | (b(at + 3) << 24)
      : (b(at) << 24) | (b(at + 1) << 16) | (b(at + 2) << 8) | b(at + 3)) >>> 0;

  if (u16(tiff + 2) !== 0x002a) return null;
  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 + 2 > bytes.length) return null;

  const readAscii = (entry: number): string | null => {
    const count = u32(entry + 4);
    if (count < 2 || count > 64) return null;
    const at = count > 4 ? tiff + u32(entry + 8) : entry + 8;
    if (at + count > bytes.length) return null;
    let s = "";
    for (let k = 0; k < count; k++) {
      const c = b(at + k);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s || null;
  };

  // DateTimeOriginal (0x9003) lives in the Exif sub-IFD (0x8769). DateTime
  // (0x0132) in IFD0 is the *file modification* time and is a poor substitute —
  // used only when the original is absent.
  let exifIfd = -1;
  let fallback: string | null = null;
  const n0 = u16(ifd0);
  for (let i = 0; i < n0; i++) {
    const e = ifd0 + 2 + i * 12;
    if (e + 12 > bytes.length) break;
    const tag = u16(e);
    if (tag === 0x8769) exifIfd = tiff + u32(e + 8);
    else if (tag === 0x0132) fallback = readAscii(e);
  }

  if (exifIfd > 0 && exifIfd + 2 <= bytes.length) {
    const nE = u16(exifIfd);
    for (let i = 0; i < nE; i++) {
      const e = exifIfd + 2 + i * 12;
      if (e + 12 > bytes.length) break;
      if (u16(e) === 0x9003) {
        const raw = readAscii(e);
        if (raw) {
          // EXIF format is "YYYY:MM:DD HH:MM:SS" — only the date half uses colons.
          const out = raw.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3").trim();
          return /^\d{4}-\d{2}-\d{2}/.test(out) ? out : null;
        }
      }
    }
  }
  if (fallback) {
    const out = fallback.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3").trim();
    return /^\d{4}-\d{2}-\d{2}/.test(out) ? out : null;
  }
  return null;
}
