import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getPark } from "./parks";
import {
  classifyContactsPage,
  extractPublishedTokens,
  probePark,
  sweepRegistry,
} from "./registry-health";

const here = dirname(fileURLToPath(import.meta.url));
// A REAL capture of https://www.nps.gov/goga/contacts.htm — the exact artifact
// classifyContactsPage() parses, not a hand-written approximation.
const GOGA_CONTACTS = readFileSync(join(here, "__fixtures__/goga-contacts.html"), "utf8");
const GOGA_STORED = getPark("goga")?.recipientToken ?? "";

describe("extractPublishedTokens (real contacts page)", () => {
  it("finds every sendemail recipient token on the page", () => {
    const toks = extractPublishedTokens(GOGA_CONTACTS);
    expect(toks.length).toBeGreaterThan(1);
    for (const t of toks) expect(t).toMatch(/^[0-9A-F]+$/);
  });
});

describe("classifyContactsPage", () => {
  it("reports ok when the stored token is published on the page", () => {
    // The committed June snapshot still contains the token we store.
    expect(classifyContactsPage("goga", GOGA_STORED, GOGA_CONTACTS, 200)).toMatchObject({
      ok: true,
    });
  });

  // ── THE NEGATIVE CONTROL THAT KILLED THE FIRST DESIGN ──────────────────────
  // The original probe asked sendemail.cfm "does a form come back?". It passed
  // for a real token AND for `DEADBEEF00`, because that endpoint echoes any
  // `o=` value and always renders the form — so it would have scored a registry
  // of 435 dead tokens as 435/435 healthy. This assertion is what makes the
  // replacement a measurement rather than a formality: mutate the token, and
  // the probe MUST notice.
  it("reports drift when the stored token is NOT on the page", () => {
    const mutated = GOGA_STORED.replace(/^.{6}/, "ABCDEF");
    expect(mutated).not.toBe(GOGA_STORED);
    expect(classifyContactsPage("goga", mutated, GOGA_CONTACTS, 200)).toMatchObject({
      ok: false,
      reason: "token_not_published",
    });
  });

  it("separates 'cannot measure' from 'token is stale'", () => {
    // A page with no tokens at all is a broken instrument, not evidence of
    // drift — conflating them would fire 435 false drift alerts on a redesign.
    expect(
      classifyContactsPage("goga", GOGA_STORED, "<html>maintenance</html>", 200),
    ).toMatchObject({ ok: false, reason: "no_tokens_on_page" });
    expect(classifyContactsPage("goga", GOGA_STORED, "", 404)).toMatchObject({
      ok: false,
      reason: "http_error",
    });
  });
});

describe("probePark", () => {
  const html = (body: string, status = 200, url = "https://www.nps.gov/goga/contacts.htm") =>
    (async () => new Response(body, { status })) as unknown as typeof fetch;

  it("requests the park's own contacts page and follows redirects", async () => {
    const seen: Array<{ url: string; redirect?: string }> = [];
    const impl = (async (u: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(u), redirect: init?.redirect });
      return new Response(GOGA_CONTACTS, { status: 200 });
    }) as unknown as typeof fetch;
    const r = await probePark(
      { code: "goga", recipientToken: GOGA_STORED, referrerPath: "/goga/contacts.htm" },
      impl,
    );
    expect(r.ok).toBe(true);
    expect(seen[0]?.url).toBe("https://www.nps.gov/goga/contacts.htm");
    // masi -> npnh and neje -> pine both 302; without follow they read as dead.
    expect(seen[0]?.redirect).toBe("follow");
  });

  it("returns network_error instead of throwing", async () => {
    const impl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const r = await probePark(
      { code: "goga", recipientToken: GOGA_STORED, referrerPath: "/goga/contacts.htm" },
      impl,
    );
    expect(r).toMatchObject({ ok: false, reason: "network_error" });
  });

  it("does not treat a form-bearing page with the wrong tokens as healthy", async () => {
    const r = await probePark(
      { code: "goga", recipientToken: "0000DEADBEEF", referrerPath: "/goga/contacts.htm" },
      html(GOGA_CONTACTS),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("token_not_published");
  });
});

describe("sweepRegistry", () => {
  it("counts drift and unreadable separately and never throws", async () => {
    const parks = [
      { code: "a", name: "A", referrerPath: "/a/contacts.htm", recipientToken: "AAAA" },
      { code: "b", name: "B", referrerPath: "/b/contacts.htm", recipientToken: "BBBB" },
      { code: "c", name: "C", referrerPath: "/c/contacts.htm", recipientToken: "CCCC" },
    ];
    const impl = (async (u: string | URL | Request) => {
      const s = String(u);
      if (s.includes("/a/")) return new Response('href="sendemail.cfm?o=AAAA"', { status: 200 });
      // Valid hex, but a DIFFERENT token than stored -> drift. (Using a
      // non-hex placeholder here would extract zero tokens and be classified
      // `no_tokens_on_page` instead, which is a different finding.)
      if (s.includes("/b/")) return new Response('href="sendemail.cfm?o=DDDD"', { status: 200 });
      throw new Error("boom");
    }) as unknown as typeof fetch;

    const sweep = await sweepRegistry({ parks, fetchImpl: impl, concurrency: 2 });
    expect(sweep.total).toBe(3);
    expect(sweep.ok).toBe(1);
    expect(sweep.drifted).toBe(1); // b: published a different token
    expect(sweep.unreadable).toBe(1); // c: could not be measured
    expect(sweep.partial).toBe(false);
  });

  it("marks a limited sweep as partial", async () => {
    const impl = (async () =>
      new Response('href="sendemail.cfm?o=AAAA"', { status: 200 })) as unknown as typeof fetch;
    const sweep = await sweepRegistry({ limit: 2, fetchImpl: impl, concurrency: 2 });
    expect(sweep.total).toBe(2);
    expect(sweep.partial).toBe(true);
  });
});
