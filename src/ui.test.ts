import { describe, expect, it } from "vitest";
import { renderAbout, renderApp } from "./ui";

// Every inline <script> body in a rendered page.
function inlineScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m = re.exec(html);
  while (m !== null) {
    const body = m[1] ?? "";
    if (body.trim()) out.push(body);
    m = re.exec(html);
  }
  return out;
}

/** The landing page's client script. Throws rather than letting a missing
 *  script silently turn every assertion below into a vacuous pass. */
function clientScript(): string {
  const [first] = inlineScripts(renderApp());
  if (!first) throw new Error("renderApp() emitted no inline <script>");
  return first;
}

// ---------------------------------------------------------------------------
// PARSE GATE
//
// The client script lives inside a TypeScript template literal. tsc does not
// parse it, biome does not parse it, and no test executes it — so a stray
// backtick, an unescaped `${`, or a bad sed/lint auto-fix aimed at a comment
// ships a page whose JavaScript cannot parse, with the whole toolchain green
// and no error anywhere but the visitor's console.
//
// `new Function(src)` compiles without executing, which is exactly the check:
// cause-agnostic (it catches any syntax error, not a list of known patterns)
// and side-effect free (no DOM needed).
// ---------------------------------------------------------------------------
describe("inline client script parses", () => {
  for (const [name, render] of [
    ["/", renderApp],
    ["/about", renderAbout],
  ] as const) {
    it(`every inline <script> on ${name} is syntactically valid JavaScript`, () => {
      const scripts = inlineScripts(render());
      for (const src of scripts) {
        // Compiles without executing — our own rendered output, never user data.
        expect(() => {
          new Function(src);
        }, `inline <script> on ${name} does not parse`).not.toThrow();
      }
    });
  }

  it("the landing page actually has a script to check (guards a vacuous pass)", () => {
    // Zero blocks would make the loop above pass while proving nothing.
    expect(inlineScripts(renderApp()).length).toBeGreaterThan(0);
  });
});

describe("EXIF readers are shipped, not re-implemented", () => {
  const html = renderApp();

  it("embeds both serialised readers from src/exif.ts", () => {
    expect(html).toContain("function readExifGps");
    expect(html).toContain("function readExifTakenAt");
  });

  it("ships no TypeScript type syntax into the browser", () => {
    // .toString() reflects the *transpiled* function. If a build ever stopped
    // stripping types, this would ship `(at: number)` and fail to parse — the
    // parse gate above would already catch it, but this names the cause.
    const script = clientScript();
    expect(script).not.toMatch(/\): ExifGps \| null \{/);
    expect(script).not.toMatch(/: Uint8Array\)/);
  });
});

describe("photo location precedence", () => {
  const script = clientScript();

  it("routes through a single coords() helper rather than reading state inline", () => {
    // The bug class here is a SECOND writer of location that forgets the photo
    // takes precedence. Keeping exactly one reader makes that impossible to add
    // by accident; this fails if someone reintroduces a direct state read.
    expect(script).toContain("function coords()");
    const directReads = script.match(/state\.deviceLat/g) ?? [];
    // One assignment in the geolocation callback + two reads inside coords().
    expect(directReads.length).toBeLessThanOrEqual(3);
  });

  it("prefers photo EXIF over device GPS inside coords()", () => {
    const body = script.slice(script.indexOf("function coords()"));
    expect(body.indexOf("state.photoLat")).toBeLessThan(body.indexOf("state.deviceLat"));
  });

  it("reads EXIF before downscaling (canvas re-encode drops metadata)", () => {
    const load = script.slice(script.indexOf("async function loadPhoto"));
    expect(load.indexOf("readExifGps(")).toBeLessThan(load.indexOf("downscale(file)"));
  });
});
