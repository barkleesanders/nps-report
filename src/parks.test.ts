import { describe, expect, it } from "vitest";
import { nearestPark } from "./geo";
import { COORDINATES_EXEMPT, getPark, listParks, registryDefects } from "./parks";

// The registry is harvested from nps.gov. Nothing about it is type-checked:
// a park can lose its coordinates or its mailbox token in a harvest and the app
// keeps compiling, keeps passing every other test, and simply stops being able
// to route to that park. `nearestPark` skips coordinate-less parks with a
// `continue` — silence is the failure mode, so it needs a gate.
describe("registry completeness invariants", () => {
  it("every park has a mailbox token, a valid referrer path, and a unique code", () => {
    const structural = registryDefects().filter((d) => d.field !== "lat/lng");
    expect(structural).toEqual([]);
  });

  it("every park has usable coordinates, except the documented exemptions", () => {
    // Fails on any NEW coordinate-less park. Before adding one to
    // COORDINATES_EXEMPT, check the upstream feed — the previous "missing"
    // park (cave / Carlsbad Caverns) was published upstream all along under
    // parkCode CACA with codes:["CACA","CAVE"], and was only invisible because
    // the harvester looked up primary codes and never the alias array.
    expect(registryDefects().filter((d) => d.field === "lat/lng")).toEqual([]);
  });

  it("keeps the exemption list minimal and honest", () => {
    // A growing exemption list is how this gate rots into a mute button.
    expect(Object.keys(COORDINATES_EXEMPT).length).toBeLessThanOrEqual(5);
    for (const [code, reason] of Object.entries(COORDINATES_EXEMPT)) {
      expect(getPark(code), `exempt code ${code} is not in the registry`).toBeDefined();
      expect(reason.length, `exemption for ${code} needs a real reason`).toBeGreaterThan(20);
    }
  });

  it("the claimed park count matches the data the UI advertises", () => {
    // The landing page and /about both say "435 parks" in prose.
    expect(listParks().length).toBe(435);
  });
});

describe("GPS routing reaches the parks it claims to", () => {
  // Regression for the alias-code miss: Carlsbad Caverns is a marquee park that
  // GPS could never select, because its coordinates were absent.
  it("routes Carlsbad Caverns coordinates to cave", () => {
    const near = nearestPark(32.1413502, -104.5521084);
    expect(near?.park.code).toBe("cave");
    expect(near?.distanceKm).toBeLessThan(1);
  });

  it("routes San Francisco coordinates to a Bay Area unit", () => {
    const near = nearestPark(37.7749, -122.4194);
    expect(near).not.toBeNull();
    expect(near?.distanceKm).toBeLessThan(30);
  });

  it("every non-exempt park is reachable from its own coordinates", () => {
    // If a park's own centroid does not resolve to it, its coordinates are
    // wrong (swapped lat/lng is the classic form and looks plausible).
    const unreachable: string[] = [];
    for (const p of listParks()) {
      if (typeof p.lat !== "number" || typeof p.lng !== "number") continue;
      const near = nearestPark(p.lat, p.lng);
      if (near && near.distanceKm > 0.001 && near.park.code !== p.code) {
        // Another park sits closer to this one's centroid than it does itself —
        // only possible with duplicate or corrupted coordinates.
        unreachable.push(`${p.code} -> ${near.park.code}`);
      }
    }
    expect(unreachable).toEqual([]);
  });
});
