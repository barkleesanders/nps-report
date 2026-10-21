import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { getPark } from "./parks";

function request(path: string, init?: RequestInit) {
  return worker.fetch(new Request(`https://nps-report.test${path}`, init), {});
}

afterEach(() => vi.restoreAllMocks());

describe("Worker HTTP contract", () => {
  it("keeps liveness uncached with security headers", async () => {
    const response = await request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "nps-report" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'none'");
  });

  it("serves the complete public registry without mailbox tokens", async () => {
    const response = await request("/api/parks");
    expect(response.status).toBe(200);
    const body = await response.json();
    if (
      !body ||
      typeof body !== "object" ||
      !("count" in body) ||
      !("parks" in body) ||
      !Array.isArray(body.parks)
    ) {
      throw new Error("Invalid public registry response");
    }
    expect(body.count).toBe(435);
    expect(body.parks).toHaveLength(435);
    expect(body.parks).toEqual(expect.arrayContaining([expect.objectContaining({ code: "goga" })]));
    for (const park of body.parks) expect(park).not.toHaveProperty("recipientToken");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("routes valid coordinates and rejects malformed JSON without network calls", async () => {
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected network"));
    const park = getPark("goga");
    if (park?.lat === undefined || park.lng === undefined) throw new Error("Missing park fixture");
    const response = await request("/api/locate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: park.lat, lng: park.lng }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ nearestPark: { code: "goga" } });
    const invalid = await request("/api/locate", { method: "POST", body: "{" });
    expect(invalid.status).toBe(400);
    expect(network).not.toHaveBeenCalled();
  });

  it("rejects invalid reports before reaching the NPS email form", async () => {
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected network"));
    const response = await request("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(400);
    expect(network).not.toHaveBeenCalled();
  });

  it("reports an unavailable AI binding without making a model request", async () => {
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected network"));
    const response = await request("/api/analyze", { method: "POST", body: "{}" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "ai_unavailable" });
    expect(network).not.toHaveBeenCalled();
  });
});
