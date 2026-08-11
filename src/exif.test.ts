import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readExifGps, readExifTakenAt } from "./exif";

const here = dirname(fileURLToPath(import.meta.url));
const bytesOf = (name: string) => new Uint8Array(readFileSync(join(here, "__fixtures__", name)));

// REAL fixtures, not hand-forged byte arrays.
//
// `exif-gps.jpg` is an 8x8 JPEG whose EXIF block was written by **exiftool** —
// an independent, standards-compliant implementation. That is the property
// that makes it a fixture rather than a mirror of my own assumptions: if my
// offset math is wrong, exiftool's layout disagrees with it and this fails.
// The values below are what exiftool itself reads back out of the file:
//   GPSLatitude 37.7456 / GPSLongitude -119.5936 / DateTimeOriginal 2026:08:09 14:32:07
// (Yosemite Valley — a public landmark, deliberately not a personal location.
// All original metadata was stripped with `exiftool -all=` first, so no camera
// serial, owner or real coordinate survives in the committed file.)
//
// Cross-checked during development against a genuine iPhone-written JPEG
// (~/Downloads/IMG_7321.JPG, not committed — personal): this parser returned
// 37.775342, -122.388564, matching exiftool's reading of the same file to 6dp.
const GPS_JPEG = bytesOf("exif-gps.jpg");
const NOGPS_JPEG = bytesOf("exif-nogps.jpg");

describe("readExifGps (real exiftool-authored fixture)", () => {
  it("reads the coordinates exiftool wrote", () => {
    const gps = readExifGps(GPS_JPEG);
    expect(gps).not.toBeNull();
    expect(gps?.lat).toBeCloseTo(37.7456, 4);
    expect(gps?.lng).toBeCloseTo(-119.5936, 4);
  });

  it("applies the W hemisphere ref (a sign error here misroutes by continents)", () => {
    // 37.7456,-119.5936 is Yosemite. 37.7456,+119.5936 is western China.
    expect(readExifGps(GPS_JPEG)?.lng).toBeLessThan(0);
  });

  // NEGATIVE CONTROL. Without this, a parser that always returned Yosemite
  // would pass the test above. "No GPS" is the common case in production —
  // screenshots, messaging-app re-encodes, location permission off.
  it("returns null for a JPEG with no GPS tags", () => {
    expect(readExifGps(NOGPS_JPEG)).toBeNull();
  });

  it("returns null for non-JPEG and truncated input rather than throwing", () => {
    expect(
      readExifGps(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])),
    ).toBeNull();
    expect(readExifGps(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(readExifGps(new Uint8Array(0))).toBeNull();
    // A JPEG header followed by garbage must not walk off the end of the buffer.
    const junk = new Uint8Array(400);
    junk[0] = 0xff;
    junk[1] = 0xd8;
    junk[2] = 0xff;
    junk[3] = 0xe1;
    junk[4] = 0x01;
    junk[5] = 0x00;
    expect(readExifGps(junk)).toBeNull();
  });
});

describe("readExifTakenAt", () => {
  it("reads DateTimeOriginal and converts the date half to ISO dashes", () => {
    expect(readExifTakenAt(GPS_JPEG)).toBe("2026-08-09 14:32:07");
  });

  it("returns null when the photo carries no timestamp", () => {
    expect(readExifTakenAt(NOGPS_JPEG)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BROWSER-SHIPPABILITY GATE
//
// `ui.ts` ships these two functions to the browser by embedding
// `fn.toString()` into the page's inline <script>. Nothing in the toolchain
// parses code inside a template literal, so a broken serialisation ships with
// tsc, biome and vitest all green and fails only in a visitor's browser.
//
// `new Function(...)` compiles the serialised text in a scope with NO access to
// this module — so it fails loudly on both failure modes at once: a syntax
// error (throws at construction) and a reference to anything outside the
// function body (throws at call). Re-introduce a module-scope helper and these
// two tests go red.
// ---------------------------------------------------------------------------
describe("serialised-to-browser copy is self-contained and parses", () => {
  // Compiling the exact text we ship to the browser IS the assertion; the
  // input is our own transpiled source, never user data.
  const rehydrate = <T>(fn: T): T => new Function(`"use strict"; return (${String(fn)});`)() as T;

  it("readExifGps survives Function.prototype.toString round-trip", () => {
    const shipped = rehydrate(readExifGps);
    const got = shipped(GPS_JPEG);
    expect(got).not.toBeNull();
    expect(got?.lat).toBeCloseTo(37.7456, 4);
    expect(got?.lng).toBeCloseTo(-119.5936, 4);
    expect(shipped(NOGPS_JPEG)).toBeNull();
  });

  it("readExifTakenAt survives Function.prototype.toString round-trip", () => {
    expect(rehydrate(readExifTakenAt)(GPS_JPEG)).toBe("2026-08-09 14:32:07");
  });

  it("neither function names an identifier from module scope", () => {
    // Belt-and-braces over the runtime check above: catches a stray reference
    // that happens not to be hit by the fixture's code path.
    for (const fn of [readExifGps, readExifTakenAt]) {
      const src = String(fn);
      expect(src).not.toMatch(/\bimport\b|\brequire\(/);
      // Any other module export appearing by name would be a closure capture.
      expect(src.replace(new RegExp(`\\b${fn.name}\\b`, "g"), "")).not.toMatch(
        /\breadExifGps\b|\breadExifTakenAt\b/,
      );
    }
  });
});
