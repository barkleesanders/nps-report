import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getPark } from "./parks";
import {
  classifyContactsPage,
  extractPublishedTokens,
  healParkToken,
  OVERRIDES_KV_KEY,
  type ParkProbe,
  planHeals,
  probePark,
  type RegistrySweep,
  runScheduledSweep,
  sweepRegistry,
} from "./registry-health";

const here = dirname(fileURLToPath(import.meta.url));
// A REAL capture of https://www.nps.gov/goga/contacts.htm — the exact artifact
// classifyContactsPage() parses, not a hand-written approximation.
const GOGA_CONTACTS = readFileSync(join(here, "__fixtures__/goga-contacts.html"), "utf8");

// The token the JUNE snapshot published. Pinned to the fixture, NOT to
// parks.data.json — these unit tests assert parser behaviour and must not
// break every time the registry is re-harvested. (They did exactly that on
// 2026-08-11 when goga's token was folded in from the healer.)
const GOGA_JUNE_TOKEN = extractPublishedTokens(GOGA_CONTACTS)[0] ?? "";
// What the registry holds right now — used only to assert the drift is real.
const GOGA_CURRENT = getPark("goga")?.recipientToken ?? "";

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
    expect(classifyContactsPage("goga", GOGA_JUNE_TOKEN, GOGA_CONTACTS, 200)).toMatchObject({
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
    const mutated = GOGA_JUNE_TOKEN.replace(/^.{6}/, "ABCDEF");
    expect(mutated).not.toBe(GOGA_JUNE_TOKEN);
    expect(classifyContactsPage("goga", mutated, GOGA_CONTACTS, 200)).toMatchObject({
      ok: false,
      reason: "token_not_published",
    });
  });

  it("separates 'cannot measure' from 'token is stale'", () => {
    // A page with no tokens at all is a broken instrument, not evidence of
    // drift — conflating them would fire 435 false drift alerts on a redesign.
    expect(
      classifyContactsPage("goga", GOGA_JUNE_TOKEN, "<html>maintenance</html>", 200),
    ).toMatchObject({ ok: false, reason: "no_tokens_on_page" });
    expect(classifyContactsPage("goga", GOGA_JUNE_TOKEN, "", 404)).toMatchObject({
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
      { code: "goga", recipientToken: GOGA_JUNE_TOKEN, referrerPath: "/goga/contacts.htm" },
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
      { code: "goga", recipientToken: GOGA_JUNE_TOKEN, referrerPath: "/goga/contacts.htm" },
      impl,
    );
    expect(r).toMatchObject({ ok: false, reason: "network_error" });
  });

  it("does not treat a form-bearing page with the wrong tokens as healthy", async () => {
    const r = await probePark(
      { code: "goga", recipientToken: "0000DEADBEEF0000", referrerPath: "/goga/contacts.htm" },
      html(GOGA_CONTACTS),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("token_not_published");
  });
});

describe("sweepRegistry", () => {
  it("counts drift and unreadable separately and never throws", async () => {
    const parks = [
      { code: "a", name: "A", referrerPath: "/a/contacts.htm", recipientToken: "AAAAAAAAAAAAAAAA" },
      { code: "b", name: "B", referrerPath: "/b/contacts.htm", recipientToken: "BBBBBBBBBBBBBBBB" },
      { code: "c", name: "C", referrerPath: "/c/contacts.htm", recipientToken: "CCCCCCCCCCCCCCCC" },
    ];
    const impl = (async (u: string | URL | Request) => {
      const s = String(u);
      if (s.includes("/a/"))
        return new Response('href="sendemail.cfm?o=AAAAAAAAAAAAAAAA"', { status: 200 });
      // Valid hex, but a DIFFERENT token than stored -> drift. (Using a
      // non-hex placeholder here would extract zero tokens and be classified
      // `no_tokens_on_page` instead, which is a different finding.)
      if (s.includes("/b/"))
        return new Response('href="sendemail.cfm?o=DDDDDDDDDDDDDDDD"', { status: 200 });
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
      new Response('href="sendemail.cfm?o=AAAAAAAAAAAAAAAA"', {
        status: 200,
      })) as unknown as typeof fetch;
    const sweep = await sweepRegistry({ limit: 2, fetchImpl: impl, concurrency: 2 });
    expect(sweep.total).toBe(2);
    expect(sweep.partial).toBe(true);
  });
});

describe("healParkToken — which published token replaces a drifted one", () => {
  it("adopts the FIRST token on the page", () => {
    const first = extractPublishedTokens(GOGA_CONTACTS)[0];
    expect(healParkToken(GOGA_CONTACTS)).toBe(first);
  });

  // CONTROL that makes "first" a measurement, not a formality. The real goga
  // page publishes 5 tokens; if first and last were the same value, the
  // position rule would be untested by the assertion above. Measured live
  // 2026-08-10 across 29 parks: stored===FIRST 24/29, stored===LAST 20/29 —
  // the gap is why this rule was chosen.
  it("the page really does offer a choice (first !== last)", () => {
    const toks = extractPublishedTokens(GOGA_CONTACTS);
    expect(toks.length).toBeGreaterThan(1);
    expect(toks[0]).not.toBe(toks[toks.length - 1]);
  });

  it("refuses to invent a token when the page has none", () => {
    expect(healParkToken("<html>maintenance</html>")).toBeNull();
    expect(healParkToken("")).toBeNull();
  });
});

describe("planHeals — the safety cap", () => {
  const drifted = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      code: `p${i}`,
      ok: false as const,
      reason: "token_not_published" as const,
      storedToken: "AAAAAAAAAAAAAAAA",
      publishedToken: "BBBBBBBBBBBBBBBB",
      publishedCount: 1,
    }));
  const sweep = (total: number, fails: ParkProbe[]): RegistrySweep => ({
    checkedAt: new Date(0).toISOString(),
    total,
    ok: total - fails.length,
    drifted: fails.filter((f) => f.reason === "token_not_published").length,
    unreadable: fails.filter((f) => f.reason !== "token_not_published").length,
    failures: fails,
    durationMs: 1,
    partial: false,
  });

  it("heals ordinary per-park rotation", () => {
    const plan = planHeals(sweep(435, drifted(5)));
    expect(plan.suppressed).toBe(false);
    expect(plan.heals.map((h) => h.code)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(plan.heals[0]).toMatchObject({
      from: "AAAAAAAAAAAAAAAA",
      to: "BBBBBBBBBBBBBBBB",
      candidates: 1,
    });
  });

  // THE control that matters most: a site-wide change must NOT be auto-adopted.
  // Without this, an NPS redesign would rewrite every park's mailbox in one
  // cron run — the single most damaging thing this feature could do.
  it("refuses to heal when drift is site-wide, and says why", () => {
    const plan = planHeals(sweep(435, drifted(200)));
    expect(plan.suppressed).toBe(true);
    expect(plan.heals).toEqual([]);
    expect(plan.reason).toMatch(/site-wide/);
  });

  it("never heals a park it could not measure", () => {
    const unreadable: ParkProbe[] = [
      { code: "x", ok: false, reason: "no_tokens_on_page", status: 200 },
      { code: "y", ok: false, reason: "network_error" },
      { code: "z", ok: false, reason: "http_error", status: 404 },
    ];
    expect(planHeals(sweep(435, unreadable)).heals).toEqual([]);
  });

  it("heals nothing when nothing drifted (and does not report suppression)", () => {
    const plan = planHeals(sweep(435, []));
    expect(plan.heals).toEqual([]);
    expect(plan.suppressed).toBe(false);
  });
});

describe("token shape bound (defense-in-depth)", () => {
  // The healer ADOPTS whatever this returns — into KV, then into the outbound
  // URL every report is addressed with. Hex-only already blocks host/scheme
  // injection; this bounds the length. Real tokens are 34-58 chars.
  it("ignores absurdly long and absurdly short hex runs", () => {
    const huge = "A".repeat(5000);
    expect(extractPublishedTokens(`sendemail.cfm?o=${huge}`)).toEqual([]);
    expect(extractPublishedTokens("sendemail.cfm?o=AB")).toEqual([]);
  });

  it("still accepts every token on the real park page", () => {
    const toks = extractPublishedTokens(GOGA_CONTACTS);
    expect(toks.length).toBeGreaterThan(1);
    for (const t of toks) expect(t.length).toBeGreaterThanOrEqual(16);
  });
});

describe("goga drift is real and documented", () => {
  // This is the assertion that the whole registry-health feature rests on: the
  // June snapshot published a token the park no longer does. Keeping it as a
  // test means the evidence survives even after the registry is re-harvested.
  it("the current registry token is NOT the one the June page published", () => {
    expect(GOGA_CURRENT).toBeTruthy();
    expect(extractPublishedTokens(GOGA_CONTACTS)).not.toContain(GOGA_CURRENT.toUpperCase());
  });

  it("and the June token is the one the June page published", () => {
    expect(extractPublishedTokens(GOGA_CONTACTS)).toContain(GOGA_JUNE_TOKEN);
  });
});

describe("runScheduledSweep prunes redundant overrides", () => {
  // A fake KV that records what was written.
  function fakeKv(initial: Record<string, unknown>) {
    const store = new Map<string, string>(
      Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]),
    );
    return {
      kv: {
        get: async (k: string, _t?: string) => {
          const raw = store.get(k);
          return raw === undefined ? null : JSON.parse(raw);
        },
        put: async (k: string, v: string) => {
          store.set(k, v);
        },
      } as unknown as KVNamespace,
      read: (k: string) => (store.has(k) ? JSON.parse(store.get(k) as string) : null),
    };
  }

  // Every park's page publishes exactly the token already baked into the
  // registry -> the whole sweep is ok, so every override is now dead weight.
  const allHealthy = (async (u: string | URL | Request) => {
    const code = String(u).match(/nps\.gov\/([^/]+)\//)?.[1] ?? "";
    const tok = getPark(code)?.recipientToken;
    return new Response(tok ? `href="sendemail.cfm?o=${tok}"` : "<html>none</html>", {
      status: 200,
    });
  }) as unknown as typeof fetch;

  it("drops an override once the baked-in token matches what the park publishes", async () => {
    const goga = getPark("goga")?.recipientToken ?? "";
    const { kv, read } = fakeKv({
      [OVERRIDES_KV_KEY]: {
        goga: { code: "goga", from: "OLD", to: goga, candidates: 1, healedAt: "x" },
      },
    });
    await runScheduledSweep(kv, allHealthy);
    expect(read(OVERRIDES_KV_KEY)).toEqual({});
  });

  // THE control: pruning on anything other than a CONFIRMED ok would mean one
  // bad-network week silently drops a live override and reverts those parks to
  // a stale mailbox.
  it("keeps an override for a park it could not read this run", async () => {
    const goga = getPark("goga")?.recipientToken ?? "";
    const gogaUnreadable = (async (u: string | URL | Request) => {
      if (String(u).includes("/goga/")) throw new Error("offline");
      return allHealthy(u);
    }) as unknown as typeof fetch;
    const { kv, read } = fakeKv({
      [OVERRIDES_KV_KEY]: {
        goga: { code: "goga", from: "OLD", to: goga, candidates: 1, healedAt: "x" },
      },
    });
    await runScheduledSweep(kv, gogaUnreadable);
    expect(Object.keys(read(OVERRIDES_KV_KEY) ?? {})).toEqual(["goga"]);
  });
});
