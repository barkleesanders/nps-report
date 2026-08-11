// Registry health — is each park's stored mailbox token still the one the park
// publishes?
//
// ─────────────────────────────────────────────────────────────────────────────
// READ THIS BEFORE CHANGING THE PROBE. The obvious check does not work.
// ─────────────────────────────────────────────────────────────────────────────
//
// The tempting probe is: "GET sendemail.cfm?o=<stored token> and check a usable
// form comes back." It reads like the consumer's own question, and it is
// **completely vacuous**. Measured against the live endpoint on 2026-08-10:
//
//     o=<real goga token>  -> HTTP 200, full form, o echoed back verbatim
//     o=DEADBEEF00         -> HTTP 200, full form, o echoed back verbatim
//     o=<omitted entirely> -> HTTP 200, 106 bytes, no form
//
// sendemail.cfm never validates `o`. It echoes whatever you send straight into
// the hidden input and renders the form regardless. So form-presence detects
// exactly one thing — the endpoint being gone — and says *nothing* about
// whether a token still reaches a mailbox. A registry of 435 dead tokens would
// score 435/435 healthy.
//
// This also falsifies a claim previously documented in this repo: that a dead
// token throws `form_not_found`, so "a broken park can never masquerade as a
// sent report". It can. `prepareReport`'s `form_not_found` guard fires only
// when `o` is missing entirely or the endpoint changes shape.
//
// WHAT ACTUALLY DISCRIMINATES
// ---------------------------
// The park's own /contacts.htm is where the mailbox token is published, so the
// answerable question is: **is the token we stored still the one the park
// publishes?** Sampled across 12 parks on 2026-08-10, following redirects:
// 11 exact matches and 1 real drift (goga). That drift is genuine — the June
// snapshot committed at __fixtures__/goga-contacts.html contains the stored
// token and the live page no longer does.
//
// Following redirects is load-bearing, not politeness: /masi/contacts.htm 302s
// to /npnh/, /neje/ to /pine/. Without `redirect: "follow"` both read as dead
// (a 260-byte stub) when both are perfectly healthy.
//
// WHAT THIS STILL CANNOT PROVE
// ----------------------------
// That an email actually arrives. Establishing that requires a POST, which
// mails a real ranger. So `token_not_published` means "re-harvest this park",
// NOT "this park is broken" — a token may well keep working after the page
// stops advertising it. It is reported as drift, never as failure.

import { listParks, type Park } from "./parks";

export type ProbeReason =
  /** Stored token is no longer published on the park's contacts page — re-harvest. */
  | "token_not_published"
  /** Page loaded but contained no sendemail links at all — page shape changed. */
  | "no_tokens_on_page"
  | "http_error"
  | "network_error";

export interface ParkProbe {
  code: string;
  /** true = the stored token is still published by the park. */
  ok: boolean;
  status?: number;
  reason?: ProbeReason;
  /** Final URL after redirects, when it differs from the requested one. */
  redirectedTo?: string;
  /** The token the park currently publishes first — the heal candidate. */
  publishedToken?: string;
  /** How many tokens the page advertised (1 = unambiguous). */
  publishedCount?: number;
  /** The token we had stored, so a heal can record what it replaced. */
  storedToken?: string;
}

/** A token replacement the sweep decided to adopt. */
export interface TokenHeal {
  code: string;
  from: string;
  to: string;
  /** Tokens on the page; 1 means there was nothing to choose between. */
  candidates: number;
  healedAt: string;
}

/**
 * SAFETY CAP on auto-healing.
 *
 * Adopting a new token is a write to where visitor reports get emailed, so the
 * healer must never act on a signal that could mean "NPS redesigned the site"
 * rather than "this park rotated its mailbox". Observed drift is ~1% (5 of 435
 * on 2026-08-10); a redesign or a bot-block would spike it toward 100%. Above
 * this fraction the sweep reports and heals NOTHING, which is the correct
 * response to an instrument that has probably stopped measuring what it thinks.
 */
export const MAX_HEAL_FRACTION = 0.06;

export interface RegistrySweep {
  checkedAt: string;
  total: number;
  ok: number;
  /** Parks whose stored token is no longer published (actionable: re-harvest). */
  drifted: number;
  /** Parks we could not read at all (network/HTTP/page shape) — NOT drift. */
  unreadable: number;
  /** Every non-ok probe, so a human can act without re-running the sweep. */
  failures: ParkProbe[];
  durationMs: number;
  /** True when only part of the registry was probed. */
  partial: boolean;
}

export const HEALTH_KV_KEY = "registry:last-sweep";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Every `sendemail.cfm?o=…` recipient token advertised on a contacts page. */
export function extractPublishedTokens(html: string): string[] {
  return [...new Set([...html.matchAll(/sendemail\.cfm\?o=([0-9A-F]+)/gi)].map((m) => m[1] ?? ""))]
    .filter(Boolean)
    .map((t) => t.toUpperCase());
}

/**
 * Decide health from an already-fetched contacts page. Split from the network
 * call so it can be tested against the committed real fixture.
 */
export function classifyContactsPage(
  code: string,
  storedToken: string,
  html: string,
  status: number,
): ParkProbe {
  if (status !== 200) return { code, ok: false, status, reason: "http_error" };
  const published = extractPublishedTokens(html);
  if (published.length === 0) {
    // Distinguished from drift deliberately: an empty page, a redesign or a
    // bot-block is a failure to MEASURE, not evidence the token is stale.
    return { code, ok: false, status, reason: "no_tokens_on_page" };
  }
  const meta = {
    publishedToken: published[0],
    publishedCount: published.length,
    storedToken: storedToken.toUpperCase(),
  };
  if (published.includes(storedToken.toUpperCase())) return { code, ok: true, status, ...meta };
  return { code, ok: false, status, reason: "token_not_published", ...meta };
}

/**
 * Which published token replaces a drifted one: **the first one on the page.**
 *
 * That is not a guess — it is the rule the original harvester used, measured
 * against the live site on 2026-08-10 across 29 park contacts pages:
 *
 *   stored === FIRST token : 24/29   (the 5 misses are exactly the drifted parks)
 *   stored === LAST  token : 20/29   <- the control
 *
 * The LAST-token score is what makes this a measurement rather than a
 * formality: if position were arbitrary, both rules would have scored the same.
 * On 3 of the 5 drifted parks the page publishes exactly ONE token, so there is
 * nothing to choose between at all.
 *
 * Returns null when the page offers nothing to adopt.
 */
export function healParkToken(html: string): string | null {
  const published = extractPublishedTokens(html);
  return published[0] ?? null;
}

/** Probe ONE park against its own published contacts page. */
export async function probePark(
  park: Pick<Park, "code" | "recipientToken" | "referrerPath">,
  fetchImpl: typeof fetch = fetch,
): Promise<ParkProbe> {
  const url = `https://www.nps.gov/${encodeURIComponent(park.code)}/contacts.htm`;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      // Load-bearing: masi -> npnh, neje -> pine. Without this they read as dead.
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "text/html" },
    });
    const html = res.ok ? await res.text() : "";
    const probe = classifyContactsPage(park.code, park.recipientToken, html, res.status);
    if (res.url && !res.url.includes(`/${park.code}/`)) probe.redirectedTo = res.url;
    return probe;
  } catch {
    return { code: park.code, ok: false, reason: "network_error" };
  }
}

/**
 * Service-level liveness, deliberately SEPARATE from token health.
 *
 * This is the only thing sendemail.cfm can actually tell us: that the submit
 * endpoint still exists and still renders a form. It says nothing about any
 * particular token — see the module header. Never fold it into a per-park ok.
 */
export async function probeSubmitEndpoint(
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status?: number }> {
  try {
    const res = await fetchImpl(
      "https://www.nps.gov/common/utilities/sendmail/sendemail.cfm?o=PROBE&r=%2Findex.htm",
      { headers: { "User-Agent": UA, Accept: "text/html" } },
    );
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: /name\s*=\s*"formMail"/i.test(await res.text()), status: res.status };
  } catch {
    return { ok: false };
  }
}

export interface SweepOptions {
  /** Parallel in-flight probes. Kept low to stay polite to nps.gov. */
  concurrency?: number;
  /** Probe only the first N parks (used by the on-demand endpoint). */
  limit?: number;
  fetchImpl?: typeof fetch;
  parks?: Park[];
}

/**
 * Probe the registry and summarise. Never throws: a sweep that half-fails must
 * still report what it learned, because a thrown sweep and a healthy sweep look
 * identical in a cron log.
 */
export async function sweepRegistry(opts: SweepOptions = {}): Promise<RegistrySweep> {
  const all = opts.parks ?? listParks();
  const parks = typeof opts.limit === "number" ? all.slice(0, opts.limit) : all;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 6, 20));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const started = Date.now();

  const results: ParkProbe[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < parks.length) {
      const park = parks[cursor++];
      if (!park) break;
      results.push(await probePark(park, fetchImpl));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, parks.length) }, worker));

  const failures = results.filter((r) => !r.ok);
  return {
    checkedAt: new Date().toISOString(),
    total: results.length,
    ok: results.length - failures.length,
    drifted: failures.filter((f) => f.reason === "token_not_published").length,
    unreadable: failures.filter((f) => f.reason !== "token_not_published").length,
    failures,
    durationMs: Date.now() - started,
    partial: parks.length < all.length,
  };
}

/**
 * Cron entry point: sweep the whole registry, persist the result, log one
 * structured line.
 *
 * The log line names the drifted park codes inline so a failure is actionable
 * without re-running a 435-request sweep. Storage failure is logged but never
 * masks the sweep result.
 */
export const OVERRIDES_KV_KEY = "registry:token-overrides";

/** code -> the token the worker should use instead of the baked-in one. */
export type TokenOverrides = Record<string, TokenHeal>;

/**
 * Decide which drifted parks to heal, applying the safety cap.
 *
 * Returns the heals to apply AND, when the cap trips, why nothing was applied —
 * "healed nothing because everything looked broken" and "healed nothing because
 * nothing was broken" are opposite situations and must never share a log line.
 */
export function planHeals(sweep: RegistrySweep): {
  heals: TokenHeal[];
  suppressed: boolean;
  reason?: string;
} {
  const now = new Date().toISOString();
  const drifted = sweep.failures.filter((f) => f.reason === "token_not_published");
  if (sweep.total > 0 && drifted.length / sweep.total > MAX_HEAL_FRACTION) {
    return {
      heals: [],
      suppressed: true,
      reason: `${drifted.length}/${sweep.total} parks drifted (> ${Math.round(
        MAX_HEAL_FRACTION * 100,
      )}%) — that is a site-wide change, not per-park rotation; refusing to auto-adopt tokens`,
    };
  }
  const heals: TokenHeal[] = [];
  for (const f of drifted) {
    // A drifted probe with no candidate cannot be healed — classifyContactsPage
    // only reaches token_not_published when the page HAD tokens, so this is a
    // belt-and-braces guard rather than an expected branch.
    if (!f.publishedToken) continue;
    heals.push({
      code: f.code,
      from: f.storedToken ?? "",
      to: f.publishedToken,
      candidates: f.publishedCount ?? 1,
      healedAt: now,
    });
  }
  return { heals, suppressed: false };
}

export async function runScheduledSweep(
  kv: KVNamespace | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<RegistrySweep> {
  const sweep = await sweepRegistry({ concurrency: 6, fetchImpl });
  const endpoint = await probeSubmitEndpoint(fetchImpl);
  const { heals, suppressed, reason: suppressedReason } = planHeals(sweep);
  console.log(
    JSON.stringify({
      event: "registry_health_sweep",
      checkedAt: sweep.checkedAt,
      total: sweep.total,
      ok: sweep.ok,
      drifted: sweep.drifted,
      unreadable: sweep.unreadable,
      submitEndpointAlive: endpoint.ok,
      durationMs: sweep.durationMs,
      // Bounded: a site-wide outage must not emit a 435-code log line.
      driftedCodes: sweep.failures
        .filter((f) => f.reason === "token_not_published")
        .slice(0, 40)
        .map((f) => f.code),
      unreadableCodes: sweep.failures
        .filter((f) => f.reason !== "token_not_published")
        .slice(0, 40)
        .map((f) => `${f.code}:${f.reason}`),
      truncated: Math.max(0, sweep.failures.length - 80),
      healed: heals.length,
      healedCodes: heals.slice(0, 40).map((h) => h.code),
      healSuppressed: suppressed,
      healSuppressedReason: suppressedReason,
    }),
  );
  if (kv) {
    try {
      await kv.put(HEALTH_KV_KEY, JSON.stringify(sweep));
    } catch (err) {
      console.log(JSON.stringify({ event: "registry_health_persist_failed", error: String(err) }));
    }
    if (heals.length) {
      try {
        // Merge, never replace: a park healed three weeks ago must keep its
        // override even if this week's sweep could not read its page.
        const prev = (await kv.get<TokenOverrides>(OVERRIDES_KV_KEY, "json")) ?? {};
        for (const h of heals) prev[h.code] = h;
        await kv.put(OVERRIDES_KV_KEY, JSON.stringify(prev));
        console.log(
          JSON.stringify({
            event: "registry_tokens_healed",
            count: heals.length,
            codes: heals.map((h) => h.code),
            totalOverrides: Object.keys(prev).length,
          }),
        );
      } catch (err) {
        // Loud: the sweep found drift and could NOT fix it. Reports to those
        // parks keep using the stale token until this succeeds.
        console.log(
          JSON.stringify({
            event: "registry_heal_persist_failed",
            error: String(err),
            codes: heals.map((h) => h.code),
          }),
        );
      }
    }
  }
  return sweep;
}
