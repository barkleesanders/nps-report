import { readFileSync } from "node:fs";
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
    expect(prepared.fields.submitted).toBe("y");
    // category normalized
    expect(prepared.fields.category).toBe("Facilities");
    // location folded into the message
    expect(prepared.fields.message).toContain("Location: Lands End Lookout");
    // body is urlencoded and round-trips
    const decoded = new URLSearchParams(prepared.body);
    expect(decoded.get("email")).toBe("reporter@example.com");
    expect(decoded.get("subject")).toBe("Broken railing at Lands End");
    expect(prepared.headers.Referer).toContain("sendemail.cfm");
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
  it("confirmed on positive phrase, rejected on error redisplay, unknown otherwise", () => {
    expect(parseSubmitResult("Thank you, your message has been sent.", 200)).toEqual({
      ok: true,
      signal: "confirmed",
    });
    expect(
      parseSubmitResult('<form name="formMail">Please correct the required fields</form>', 200),
    ).toEqual({ ok: false, signal: "rejected" });
    expect(parseSubmitResult("<html>unrelated</html>", 200)).toEqual({
      ok: false,
      signal: "unknown",
    });
    expect(parseSubmitResult("oops", 500)).toEqual({ ok: false, signal: "rejected" });
  });
});
