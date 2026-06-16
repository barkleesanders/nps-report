// NPS "Email Us" client.
//
// The National Park Service has NO public service-request API (unlike SF311 /
// Open311). The only programmatic submission path is the per-park ColdFusion
// contact form. This module wraps it, mirroring the verified browser sequence:
//
//   GET  /common/utilities/sendmail/sendemail.cfm?o=<token>&r=<referrer>
//        -> parse hidden inputs (o, hpt, r, type, submitted)
//   POST /common/utilities/sendmail/sendemail.cfm
//        x-www-form-urlencoded, echoing the hidden inputs unchanged + the
//        reporter's email/subject/category/fullname/message
//
// Contract verified 2026-06-15 by fetching the live Golden Gate form. There is
// NO CAPTCHA (only an `hpt` server-issued anti-spam token, which we capture
// from the GET and echo back). There is NO geo field — location goes in the
// free-text message. The response is an EMAIL to the park: no case ID, no
// status. Treat every submission as a real visitor email.

import { normalizeCategory } from "./categories";

export const NPS_ORIGIN = "https://www.nps.gov";
export const SENDMAIL_PATH = "/common/utilities/sendmail/sendemail.cfm";

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class NpsReportError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NpsReportError";
    this.code = code;
  }
}

export interface ReportInput {
  /** The obfuscated `o=` recipient token identifying the park mailbox. */
  recipientToken: string;
  /** Referrer path the form was reached from, e.g. "/goga/contacts.htm". */
  referrerPath: string;
  /** User/app category; normalized to an official NPS category internally. */
  category?: string;
  /** Short subject line. */
  subject: string;
  /** The core report text (what's broken). */
  description: string;
  /** Free-text location — embedded into the message (no geo field exists). */
  location?: string;
  /** GPS latitude — embedded as a coordinate line + maps link in the message. */
  lat?: number;
  /** GPS longitude. */
  lng?: number;
  /** Free-text observed date/time — embedded into the message. */
  observedAt?: string;
  /** Reporter email (required by the form). */
  email: string;
  /** Reporter full name. */
  fullname?: string;
  /** Optional reporter postal address fields. */
  address?: {
    address1?: string;
    address2?: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
  };
}

export interface PreparedReport {
  endpoint: string;
  method: "POST";
  headers: Record<string, string>;
  /** The exact form fields that will be POSTed (decoded, for inspection). */
  fields: Record<string, string>;
  /** URL-encoded body string. */
  body: string;
}

export interface SubmitResult {
  ok: boolean;
  /** True when we did NOT actually fire the POST (default-safe behavior). */
  dryRun: boolean;
  /** Confidence in the success determination: see parseSubmitResult. */
  signal: "confirmed" | "rejected" | "unknown" | "dry-run";
  /** HTTP status of the POST (absent on dry runs). */
  status?: number;
  /** The prepared request (always present, so callers can audit/replay). */
  prepared: PreparedReport;
  /** Short human-readable note. */
  note: string;
}

// ---- HTML parsing -----------------------------------------------------------

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m?.[1] ?? null;
}

/** Extract every hidden <input> as name -> value (value defaults to ""). */
export function parseHiddenInputs(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const tags = html.match(/<input\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!/type\s*=\s*"hidden"/i.test(tag)) continue;
    const name = attr(tag, "name");
    if (!name) continue;
    out[name] = attr(tag, "value") ?? "";
  }
  return out;
}

/** Build the GET URL for a park mailbox form. */
export function sendmailUrl(recipientToken: string, referrerPath: string): string {
  const u = new URL(SENDMAIL_PATH, NPS_ORIGIN);
  u.searchParams.set("o", recipientToken);
  u.searchParams.set("r", referrerPath);
  return u.toString();
}

/** Embed location/coords/date into the free-text message (NPS has no geo field). */
export function composeMessage(input: {
  description: string;
  location?: string;
  lat?: number;
  lng?: number;
  observedAt?: string;
}): string {
  const lines: string[] = [];
  if (input.location) lines.push(`Location: ${input.location}`);
  if (typeof input.lat === "number" && typeof input.lng === "number") {
    const coords = `${input.lat.toFixed(5)}, ${input.lng.toFixed(5)}`;
    lines.push(
      `Coordinates: ${coords} — https://www.google.com/maps/search/?api=1&query=${input.lat},${input.lng}`,
    );
  }
  if (input.observedAt) lines.push(`Observed: ${input.observedAt}`);
  if (lines.length) lines.push("");
  lines.push(input.description.trim());
  return lines.join("\n");
}

// ---- validation -------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(input: ReportInput): void {
  if (!input.recipientToken?.trim()) {
    throw new NpsReportError("missing_recipient", "recipientToken is required");
  }
  if (!input.referrerPath?.trim() || !input.referrerPath.startsWith("/")) {
    throw new NpsReportError("bad_referrer", "referrerPath must be a path like /goga/contacts.htm");
  }
  if (!input.email || !EMAIL_RE.test(input.email)) {
    throw new NpsReportError("bad_email", "a valid reporter email is required");
  }
  if (!input.subject?.trim()) {
    throw new NpsReportError("missing_subject", "subject is required");
  }
  if (!input.description?.trim()) {
    throw new NpsReportError("missing_description", "description is required");
  }
}

// ---- prepare ----------------------------------------------------------------

/**
 * Fetch the live form, capture its hidden tokens, and assemble the exact POST
 * that would submit the report. Does NOT send anything.
 */
export async function prepareReport(
  input: ReportInput,
  fetchImpl: typeof fetch = fetch,
  userAgent: string = DEFAULT_UA,
): Promise<PreparedReport> {
  validate(input);

  const getUrl = sendmailUrl(input.recipientToken, input.referrerPath);
  const res = await fetchImpl(getUrl, {
    method: "GET",
    headers: { "User-Agent": userAgent, Accept: "text/html" },
  });
  if (!res.ok) {
    throw new NpsReportError("form_fetch_failed", `GET form returned HTTP ${res.status}`);
  }
  const html = await res.text();
  if (!/name\s*=\s*"formMail"/i.test(html)) {
    throw new NpsReportError(
      "form_not_found",
      "sendemail.cfm did not return the contact form (recipient token may be invalid)",
    );
  }

  const hidden = parseHiddenInputs(html);
  // The form ships these hidden inputs; echo them back unchanged. `hpt` is the
  // per-load anti-spam token — capturing it from the GET is the whole point.
  const o = hidden.o ?? input.recipientToken;
  const hpt = hidden.hpt ?? "";
  const r = hidden.r ?? encodeURIComponent(input.referrerPath);
  const type = hidden.type ?? "contact";
  const submitted = hidden.submitted ?? "y";

  const fields: Record<string, string> = {
    hpt,
    type,
    submitted,
    r,
    o,
    email: input.email,
    subject: input.subject,
    category: normalizeCategory(input.category),
    fullname: input.fullname ?? "",
    address1: input.address?.address1 ?? "",
    address2: input.address?.address2 ?? "",
    city: input.address?.city ?? "",
    state: input.address?.state ?? "",
    zip: input.address?.zip ?? "",
    country: input.address?.country ?? "",
    message: composeMessage(input),
  };

  const body = new URLSearchParams(fields).toString();

  return {
    // POST back to the SAME URL as the GET — with the ?o=&r= query string. The
    // server reads o/r from the query; POSTing to the bare endpoint is rejected
    // ("you have come to this page in error"). Verified against a real browser
    // submission 2026-06-16 (captured POST kept the query string).
    endpoint: getUrl,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
      Origin: NPS_ORIGIN,
      Referer: getUrl,
      Accept: "text/html",
    },
    fields,
    body,
  };
}

// ---- result parsing ---------------------------------------------------------

const CONFIRM_RE =
  /(thank you|has been sent|was sent|message (was|has been) (sent|received)|we('| ha)ve received|successfully sent|your (message|email|comment))/i;
const REJECT_RE = /(error|required|please (correct|complete|enter)|invalid|try again)/i;

/**
 * Heuristic success determination from the POST response.
 *
 * PROVISIONAL: a real success page has not been captured (doing so would email a
 * live park). `confirmed` requires a positive phrase and no error phrase;
 * `rejected` requires an error phrase; otherwise `unknown` — callers should
 * surface "submitted, confirmation unverified" rather than claim success.
 */
export function parseSubmitResult(
  html: string,
  status: number,
): { ok: boolean; signal: SubmitResult["signal"] } {
  if (status >= 400) return { ok: false, signal: "rejected" };
  const positive = CONFIRM_RE.test(html);
  const formRedisplayed = /name\s*=\s*"formMail"/i.test(html);
  const negative = REJECT_RE.test(html) && formRedisplayed;
  if (positive && !negative) return { ok: true, signal: "confirmed" };
  if (negative) return { ok: false, signal: "rejected" };
  return { ok: false, signal: "unknown" };
}

// ---- submit -----------------------------------------------------------------

export interface SubmitOptions {
  /** Must be explicitly true to actually email the park. Default: dry run. */
  send?: boolean;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

/**
 * Prepare and (only if opts.send === true) submit a park report.
 *
 * Dry run is the default: the prepared request is returned without firing, so
 * an app can preview exactly what would be emailed. Pass { send: true } to
 * actually deliver it to the park mailbox.
 */
export async function submitReport(
  input: ReportInput,
  opts: SubmitOptions = {},
): Promise<SubmitResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const userAgent = opts.userAgent ?? DEFAULT_UA;
  const prepared = await prepareReport(input, fetchImpl, userAgent);

  if (!opts.send) {
    return {
      ok: true,
      dryRun: true,
      signal: "dry-run",
      prepared,
      note: "Dry run — nothing was sent. Pass send:true to email the park.",
    };
  }

  const res = await fetchImpl(prepared.endpoint, {
    method: "POST",
    headers: prepared.headers,
    body: prepared.body,
    redirect: "manual",
  });
  const status = res.status;
  // 3xx redirect after POST is the classic ColdFusion success pattern.
  if (status >= 300 && status < 400) {
    return {
      ok: true,
      dryRun: false,
      signal: "confirmed",
      status,
      prepared,
      note: `Submitted (HTTP ${status} redirect — typical success).`,
    };
  }
  const html = await res.text().catch(() => "");
  const { ok, signal } = parseSubmitResult(html, status);
  return {
    ok,
    dryRun: false,
    signal,
    status,
    prepared,
    note:
      signal === "confirmed"
        ? "Submitted — confirmation phrase detected."
        : signal === "rejected"
          ? "Park form rejected the submission (validation/error)."
          : "Submitted, but confirmation could not be verified from the response.",
  };
}
