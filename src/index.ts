// nps-report — Report broken things in US National Parks.
//
// A Hono + Cloudflare Worker that wraps the NPS per-park "Email Us" contact
// form (sendemail.cfm), the way improvebayarea.com wraps SF311. Adds AI photo
// classification + GPS location (nearest-park routing + coordinate embedding).
// Honest ceiling: it EMAILS the park (no tracked case ID, no status). Dry-run
// by default.
//
// Routes:
//   GET  /                  — landing page
//   GET  /health            — liveness
//   GET  /api/categories    — the 9 official NPS report categories
//   GET  /api/parks         — registered parks (recipient tokens redacted)
//   GET  /api/parks/:code   — one park
//   POST /api/locate        — { lat, lng } -> nearest park + coordinate line
//   POST /api/analyze       — photo (+ optional GPS) -> AI category/subject/description
//   POST /api/report        — prepare (default) or send a report to a park
//
import { Hono } from "hono";
import { cors } from "hono/cors";
import { analyzePhoto } from "./ai";
import { NPS_CATEGORIES, normalizeCategory } from "./categories";
import { isValidLatLng, locationLine, nearestPark } from "./geo";
import { NpsReportError, type ReportInput, submitReport } from "./nps";
import { getPark, listParks, publicPark, registryHarvestedAt } from "./parks";
import {
  HEALTH_KV_KEY,
  OVERRIDES_KV_KEY,
  type RegistrySweep,
  runScheduledSweep,
  sweepRegistry,
  type TokenOverrides,
} from "./registry-health";
import { faviconSvg, renderAbout, renderApp } from "./ui";

// Strict CSP for the API + a slightly looser one for the HTML page (Google
// Fonts + the page's own inline script/styles; no third-party JS).
const API_CSP =
  "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'; object-src 'none'";
const PAGE_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; " +
  "base-uri 'self'; frame-ancestors 'none'; object-src 'none'";

interface Env {
  AI: Ai;
  SERVICE_NAME?: string;
  DEFAULT_FROM_NAME?: string;
  DEFAULT_FROM_EMAIL?: string;
  NPS_API_KEY?: string;
  /** Stores the weekly consumer-path sweep result (see registry-health.ts). */
  REGISTRY_HEALTH?: KVNamespace;
}

const app = new Hono<{ Bindings: Env }>();

// Security headers on every response (manual — no invented framework API).
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Frame-Options", "DENY");
  c.header(
    "Content-Security-Policy",
    c.req.path === "/" || c.req.path === "/about" ? PAGE_CSP : API_CSP,
  );
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");

  // Workers Cache opt-in (2026-07-06): public parks data — cacheable so
  // `cache.enabled` hits skip the Worker. /health stays no-store (a cached
  // health response would mask an outage from monitors; without an explicit
  // header CF would heuristically cache the bare 200 for 2h). Route-set
  // Cache-Control always wins over these defaults.
  if (!c.res.headers.get("Cache-Control")) {
    if (c.req.path === "/health") {
      c.header("Cache-Control", "no-store");
    } else if (c.req.method === "GET" && c.res.status === 200) {
      c.header("Cache-Control", "public, max-age=3600");
    }
  }
});

app.use("/api/*", cors());

app.get("/health", (c) => c.json({ ok: true, service: c.env.SERVICE_NAME ?? "nps-report" }));

app.get("/api/categories", (c) =>
  c.json({
    categories: NPS_CATEGORIES,
    note: "Facilities and Safety are the 'broken things' buckets. Unknown inputs map to Other.",
  }),
);

app.get("/api/parks", (c) =>
  c.json({ count: listParks().length, parks: listParks().map(publicPark) }),
);

app.get("/api/parks/:code", (c) => {
  const park = getPark(c.req.param("code"));
  if (!park) return c.json({ error: "park_not_found", code: c.req.param("code") }, 404);
  return c.json(publicPark(park));
});

// ---- /api/locate : lat/lng -> nearest registered park ----------------------

app.post("/api/locate", async (c) => {
  let body: { lat?: number; lng?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "bad_json" }, 400);
  }
  if (!isValidLatLng(body.lat, body.lng)) {
    return c.json({ error: "bad_coords", message: "lat and lng are required numbers" }, 400);
  }
  const lat = body.lat as number;
  const lng = body.lng as number;
  const near = nearestPark(lat, lng);
  return c.json({
    locationLine: locationLine(lat, lng),
    nearestPark: near
      ? { ...publicPark(near.park), distanceKm: Math.round(near.distanceKm) }
      : null,
  });
});

// ---- /api/analyze : photo -> AI suggestion ---------------------------------

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^;]+;base64,/, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

app.post("/api/analyze", async (c) => {
  if (!c.env.AI) {
    return c.json({ error: "ai_unavailable", message: "Workers AI binding not configured" }, 503);
  }
  let body: { imageBase64?: string; imageUrl?: string; lat?: number; lng?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "bad_json" }, 400);
  }
  let bytes: Uint8Array;
  try {
    if (body.imageBase64) {
      bytes = base64ToBytes(body.imageBase64);
    } else if (body.imageUrl) {
      const r = await fetch(body.imageUrl);
      if (!r.ok) return c.json({ error: "image_fetch_failed", status: r.status }, 400);
      bytes = new Uint8Array(await r.arrayBuffer());
    } else {
      return c.json({ error: "missing_image", message: "provide imageBase64 or imageUrl" }, 400);
    }
  } catch (err) {
    return c.json({ error: "bad_image", message: String(err) }, 400);
  }

  let suggestion: Awaited<ReturnType<typeof analyzePhoto>>;
  try {
    suggestion = await analyzePhoto(c.env.AI, bytes);
  } catch (err) {
    return c.json({ error: "ai_failed", message: String(err) }, 502);
  }
  const near = isValidLatLng(body.lat, body.lng)
    ? nearestPark(body.lat as number, body.lng as number)
    : null;
  return c.json({
    ...suggestion,
    location: isValidLatLng(body.lat, body.lng)
      ? locationLine(body.lat as number, body.lng as number)
      : undefined,
    suggestedPark: near
      ? { ...publicPark(near.park), distanceKm: Math.round(near.distanceKm) }
      : null,
  });
});

// ---- /api/report : prepare (default) or send ------------------------------

interface ReportBody {
  parkCode?: string;
  recipientToken?: string;
  referrerPath?: string;
  category?: string;
  subject?: string;
  description?: string;
  location?: string;
  lat?: number;
  lng?: number;
  observedAt?: string;
  email?: string;
  fullname?: string;
  address?: ReportInput["address"];
  /** Must be explicitly true to actually email the park. Default: dry run. */
  send?: boolean;
}

app.post("/api/report", async (c) => {
  let body: ReportBody;
  try {
    body = await c.req.json<ReportBody>();
  } catch {
    return c.json({ error: "bad_json", message: "request body must be JSON" }, 400);
  }

  // Resolve the park mailbox: by parkCode, explicit token+referrer, or — like
  // improvebayarea — auto-route from GPS to the nearest registered park.
  let recipientToken = body.recipientToken;
  let referrerPath = body.referrerPath;
  let parkName: string | undefined;
  let parkCode: string | undefined;
  let resolvedBy: "parkCode" | "coordinates" | "explicit" | undefined;

  if (body.parkCode) {
    const park = getPark(body.parkCode);
    if (!park) {
      return c.json(
        { error: "park_not_found", code: body.parkCode, hint: "GET /api/parks for the list" },
        404,
      );
    }
    recipientToken = park.recipientToken;
    referrerPath = park.referrerPath;
    parkName = park.name;
    parkCode = park.code;
    resolvedBy = "parkCode";
  } else if (!recipientToken && isValidLatLng(body.lat, body.lng)) {
    const near = nearestPark(body.lat as number, body.lng as number);
    if (near) {
      recipientToken = near.park.recipientToken;
      referrerPath = near.park.referrerPath;
      parkName = near.park.name;
      parkCode = near.park.code;
      resolvedBy = "coordinates";
    }
  } else if (recipientToken && referrerPath) {
    resolvedBy = "explicit";
  }

  if (!recipientToken || !referrerPath) {
    return c.json(
      {
        error: "missing_target",
        message:
          "provide parkCode, or both recipientToken+referrerPath, or lat+lng near a registered park",
      },
      400,
    );
  }

  // Apply a healed token if the weekly sweep found this park's baked-in one is
  // no longer the one it publishes. parks.data.json ships inside the bundle and
  // cannot be rewritten at runtime, so KV is the only place a self-heal can
  // land — and this is the one place it has to be consulted, because it is
  // where a report gets addressed. An explicitly-supplied recipientToken is
  // NEVER overridden: the caller asked for that mailbox by name.
  let healedFrom: string | undefined;
  if (parkCode && resolvedBy !== "explicit" && c.env.REGISTRY_HEALTH) {
    try {
      const overrides = await c.env.REGISTRY_HEALTH.get<TokenOverrides>(OVERRIDES_KV_KEY, "json");
      const hit = overrides?.[parkCode];
      if (hit?.to && hit.to !== recipientToken) {
        healedFrom = recipientToken;
        recipientToken = hit.to;
        console.log(
          JSON.stringify({
            event: "recipient_token_override_applied",
            park: parkCode,
            healedAt: hit.healedAt,
          }),
        );
      }
    } catch (err) {
      // Fail OPEN to the baked-in token: a KV blip must not stop a visitor
      // filing a report. Logged so a persistent failure is visible.
      console.log(
        JSON.stringify({
          event: "recipient_token_override_read_failed",
          park: parkCode,
          error: String(err),
        }),
      );
    }
  }

  const input: ReportInput = {
    recipientToken,
    referrerPath,
    category: body.category,
    subject: body.subject ?? "",
    description: body.description ?? "",
    location: body.location,
    lat: isValidLatLng(body.lat, body.lng) ? (body.lat as number) : undefined,
    lng: isValidLatLng(body.lat, body.lng) ? (body.lng as number) : undefined,
    observedAt: body.observedAt,
    email: body.email || c.env.DEFAULT_FROM_EMAIL || "",
    fullname: body.fullname || c.env.DEFAULT_FROM_NAME || "",
    address: body.address,
  };

  try {
    const result = await submitReport(input, { send: body.send === true });
    return c.json({
      ok: result.ok,
      dryRun: result.dryRun,
      signal: result.signal,
      status: result.status,
      note: result.note,
      category: normalizeCategory(body.category),
      park: parkCode
        ? {
            code: parkCode,
            name: parkName,
            resolvedBy,
            // Present only when the weekly sweep had re-harvested this park's
            // mailbox; makes a self-heal visible in the response, not silent.
            ...(healedFrom ? { tokenHealed: true } : {}),
          }
        : undefined,
      prepared: { endpoint: result.prepared.endpoint, fields: result.prepared.fields },
    });
  } catch (err) {
    if (err instanceof NpsReportError) {
      return c.json({ error: err.code, message: err.message }, 400);
    }
    return c.json({ error: "submit_failed", message: String(err) }, 502);
  }
});

// ---- /api/registry/health : is the harvested registry still usable? --------

app.get("/api/registry/health", async (c) => {
  c.header("Cache-Control", "public, max-age=300");
  const harvestedAt = registryHarvestedAt();

  // Live sample path: ?sample=N probes N parks right now. Bounded hard — this
  // is a public endpoint and each probe is a request to nps.gov.
  const sampleParam = c.req.query("sample");
  if (sampleParam) {
    const n = Number.parseInt(sampleParam, 10);
    if (!Number.isFinite(n) || n < 1 || n > 25) {
      return c.json({ error: "bad_sample", message: "sample must be 1-25" }, 400);
    }
    const sweep = await sweepRegistry({ limit: n, concurrency: 4 });
    return c.json({ source: "live-sample", harvestedAt, ...sweep });
  }

  // Default: the last scheduled whole-registry sweep.
  let stored: RegistrySweep | null = null;
  if (c.env.REGISTRY_HEALTH) {
    try {
      stored = await c.env.REGISTRY_HEALTH.get<RegistrySweep>(HEALTH_KV_KEY, "json");
    } catch (err) {
      console.log(JSON.stringify({ event: "registry_health_read_failed", error: String(err) }));
    }
  }
  if (!stored) {
    // Say WHY there is no answer. "No data yet" and "storage is broken" are
    // different problems, and neither is "the registry is healthy".
    return c.json(
      {
        source: "none",
        harvestedAt,
        message: c.env.REGISTRY_HEALTH
          ? "No sweep recorded yet — the weekly cron has not run. Use ?sample=10 to probe live."
          : "REGISTRY_HEALTH KV is not bound; scheduled sweeps cannot be stored.",
        registrySize: listParks().length,
      },
      503,
    );
  }
  let overrides: TokenOverrides | null = null;
  if (c.env.REGISTRY_HEALTH) {
    try {
      overrides = await c.env.REGISTRY_HEALTH.get<TokenOverrides>(OVERRIDES_KV_KEY, "json");
    } catch {
      overrides = null;
    }
  }
  const ageHours = Math.round((Date.now() - Date.parse(stored.checkedAt)) / 36e5);
  return c.json({
    source: "last-scheduled-sweep",
    harvestedAt,
    // Parks the cron has re-harvested since the last `npm run harvest`.
    healedParks: overrides ? Object.keys(overrides).sort() : [],
    ageHours,
    // A sweep older than ~2 cron periods means the cron itself stopped.
    stale: ageHours > 24 * 15,
    ...stored,
  });
});

app.get("/favicon.svg", (c) => {
  c.header("Content-Type", "image/svg+xml");
  c.header("Cache-Control", "public, max-age=86400");
  return c.body(faviconSvg());
});

app.get("/", (c) => c.html(renderApp()));
app.get("/about", (c) => c.html(renderAbout()));

export default {
  fetch: app.fetch,
  /**
   * Weekly consumer-path sweep (see wrangler.toml [triggers]). Awaited via
   * waitUntil so the sweep is not cut off when the handler returns.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledSweep(env.REGISTRY_HEALTH));
  },
} satisfies ExportedHandler<Env>;
