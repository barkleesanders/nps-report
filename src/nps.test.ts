import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeCategory } from "./categories";
import {
  composeMessage,
  parseHiddenInputs,
  parseSubmitResult,
  prepareReport,
  sendmailUrl,
  submitReport,
} from "./nps";

const here = dirname(fileURLToPath(import.meta.url));
const FORM_HTML = readFileSync(join(here, "__fixtures__/goga-sendemail.html"), "utf8");

// Minimal fetch recorder. GET returns the real captured form; POST returns
// whatever the test queues.
function mockFetch(postResponse?: { status: number; body?: string }) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url: String(url), method, body: init?.body as string | undefined });
    if (method === "GET") return new Response(FORM_HTML, { status: 200 });
    const r = postResponse ?? { status: 200, body: "Thank you, your message has been sent." };
    return new Response(r.body ?? "", { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const baseInput = {
  recipientToken: "4C8ADCBAA2C0AAAE82B210AAC605AEBC5398559B4F96828F4C51A98808",
  referrerPath: "/goga/contacts.htm",
  category: "maintenance",
  subject: "Broken railing at Lands End",
  description: "The railing is cracked and loose near the overlook.",
  location: "Lands End Lookout",
  email: "reporter@example.com",
  fullname: "Jane Visitor",
};

describe("parseHiddenInputs (real fixture)", () => {
  it("extracts the five hidden inputs from the live NPS form", () => {
    const hidden = parseHiddenInputs(FORM_HTML);
    expect(Object.keys(hidden).sort()).toEqual(["hpt", "o", "r", "submitted", "type"]);
    expect(hidden.type).toBe("contact");
    expect(hidden.submitted).toBe("y");
    expect(hidden.hpt).toBeTruthy(); // server-issued anti-spam token
    expect(hidden.o).toMatch(/^[0-9A-F]+$/);
  });
});

describe("sendmailUrl", () => {
  it("builds the GET URL with o and r params", () => {
    const u = sendmailUrl("TOKEN123", "/goga/contacts.htm");
    expect(u).toContain("/common/utilities/sendmail/sendemail.cfm");
    expect(u).toContain("o=TOKEN123");
    expect(u).toContain("r=%2Fgoga%2Fcontacts.htm");
  });
});

describe("composeMessage", () => {
  it("embeds location and date into the free-text body", () => {
    const msg = composeMessage({
      description: "Cracked railing.",
      location: "Lands End",
      observedAt: "2026-06-15",
    });
    expect(msg).toContain("Location: Lands End");
    expect(msg).toContain("Observed: 2026-06-15");
    expect(msg.trim().endsWith("Cracked railing.")).toBe(true);
  });
});

describe("normalizeCategory", () => {
  it("maps broken-thing phrasings onto Facilities/Safety", () => {
    expect(normalizeCategory("maintenance")).toBe("Facilities");
    expect(normalizeCategory("broken")).toBe("Facilities");
    expect(normalizeCategory("hazard")).toBe("Safety");
    expect(normalizeCategory("Safety")).toBe("Safety");
    expect(normalizeCategory("ADA")).toBe("Accessibility");
    expect(normalizeCategory("totally-unknown-xyz")).toBe("Other");
    expect(normalizeCategory(undefined)).toBe("Facilities");
    // keyword-in-phrase (the bug found during the smoke test)
    expect(normalizeCategory("broken railing")).toBe("Facilities");
    expect(normalizeCategory("dangerous cliff edge")).toBe("Safety");
    expect(normalizeCategory("the restroom is closed")).toBe("Facilities");
  });
});

describe("prepareReport", () => {
  it("echoes the hidden tokens and builds the POST fields from the real form", async () => {
    const { impl, calls } = mockFetch();
    const prepared = await prepareReport(baseInput, impl);
    // exactly one GET, no POST
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    // hidden tokens echoed from the fixture
    const live = parseHiddenInputs(FORM_HTML);
    expect(prepared.fields.hpt).toBe(live.hpt);
    expect(prepared.fields.type).toBe("contact");
    expect(prepared.fields.submitted).toBe("y"); // echoed from the form as-is
    // category normalized
    expect(prepared.fields.category).toBe("Facilities");
    // location folded into the message
    expect(prepared.fields.message).toContain("Location: Lands End Lookout");
    // body is urlencoded and round-trips
    const decoded = new URLSearchParams(prepared.body);
    expect(decoded.get("email")).toBe("reporter@example.com");
    expect(decoded.get("subject")).toBe("Broken railing at Lands End");
    expect(prepared.headers.Referer).toContain("sendemail.cfm");
    // POST endpoint MUST keep the ?o=&r= query string (server reads them from
    // the URL; bare endpoint is rejected). Verified against a real browser POST.
    expect(prepared.endpoint).toContain("sendemail.cfm?");
    expect(prepared.endpoint).toContain(`o=${baseInput.recipientToken}`);
    expect(prepared.endpoint).toContain("r=");
  });

  it("rejects invalid input before any network call", async () => {
    const { impl, calls } = mockFetch();
    await expect(prepareReport({ ...baseInput, email: "not-an-email" }, impl)).rejects.toThrow(
      /email/i,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("submitReport — dry run is the default", () => {
  it("does NOT fire a POST unless send:true", async () => {
    const { impl, calls } = mockFetch();
    const res = await submitReport(baseInput, { fetchImpl: impl });
    expect(res.dryRun).toBe(true);
    expect(res.signal).toBe("dry-run");
    expect(res.ok).toBe(true);
    // one GET to read tokens, zero POSTs
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("fires a POST and reports confirmed on a success page", async () => {
    const { impl, calls } = mockFetch({ status: 200, body: "Thank you — your message was sent." });
    const res = await submitReport(baseInput, { fetchImpl: impl, send: true });
    expect(res.dryRun).toBe(false);
    expect(res.ok).toBe(true);
    expect(res.signal).toBe("confirmed");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("treats a 3xx redirect after POST as success (ColdFusion pattern)", async () => {
    const { impl } = mockFetch({ status: 302 });
    const res = await submitReport(baseInput, { fetchImpl: impl, send: true });
    expect(res.ok).toBe(true);
    expect(res.signal).toBe("confirmed");
  });
});

describe("parseSubmitResult", () => {
  it("confirmed on positive phrase, rejected on error redisplay", () => {
    expect(parseSubmitResult("Thank you, your message has been sent.", 200)).toEqual({
      ok: true,
      signal: "confirmed",
    });
    expect(
      parseSubmitResult('<form name="formMail">Please correct the required fields</form>', 200),
    ).toEqual({ ok: false, signal: "rejected" });
    expect(parseSubmitResult("oops", 500)).toEqual({ ok: false, signal: "rejected" });
  });

  // The behaviour the audit flagged: an unrecognised confirmation page used to
  // return ok:false, telling a visitor their report failed when the park had
  // already received it. NPS issues no case number, so their only recourse is
  // to send again — a duplicate the park can never de-duplicate.
  it("treats an unrecognised 2xx page with no form as SENT, not failed", () => {
    expect(parseSubmitResult("<html>Your submission is complete.</html>", 200)).toEqual({
      ok: true,
      signal: "unknown",
    });
  });

  it("treats a redisplayed form with no confirmation as NOT sent", () => {
    // The form coming back is the ColdFusion bounce shape even when the error
    // text is missing or reworded, so this direction stays ok:false.
    expect(parseSubmitResult('<form name="formMail"><input></form>', 200)).toEqual({
      ok: false,
      signal: "unknown",
    });
  });

  // NEGATIVE CONTROL against a REAL artifact. The GET form is the closest thing
  // we have to a real failure response, and it must never read as success. This
  // is the one real-input assertion this function has — see
  // __fixtures__/POST-RESPONSE-MISSING.md for why there is no real POST fixture.
  it("never reports the real NPS form page as a confirmed send", () => {
    const r = parseSubmitResult(FORM_HTML, 200);
    expect(r.signal).not.toBe("confirmed");
    expect(r.ok).toBe(false);
  });
});

describe("fixture honesty", () => {
  // parseSubmitResult parses a POST *response*; every HTML fixture we own is a
  // GET of the *form*. Having fixtures is not the property that matters —
  // having a fixture of the artifact the function actually parses is. This test
  // fails the moment someone deletes the marker without capturing the response,
  // so the gap cannot quietly reappear as a comment claiming verification.
  const fixtureDir = join(here, "__fixtures__");
  const marker = join(fixtureDir, "POST-RESPONSE-MISSING.md");

  it("documents the missing POST-response fixture until one is captured", () => {
    const captured = ["sendemail-post-success.html", "sendemail-post-rejected.html"].every((f) =>
      existsSync(join(fixtureDir, f)),
    );
    if (captured) {
      expect(
        existsSync(marker),
        "real POST fixtures exist — delete POST-RESPONSE-MISSING.md and assert against them",
      ).toBe(false);
      return;
    }
    expect(
      existsSync(marker),
      "no real POST-response fixture exists; the gap must stay documented",
    ).toBe(true);
  });

  it("keeps nps.ts from re-asserting a verification it cannot show", () => {
    const src = readFileSync(join(here, "nps.ts"), "utf8");
    const claims = src.match(/VERIFIED[^\n]*live submission/gi) ?? [];
    expect(
      claims,
      "nps.ts claims a verified live submission, but no POST response is saved to prove it",
    ).toEqual([]);
  });
});
