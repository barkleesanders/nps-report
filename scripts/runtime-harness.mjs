import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTestHarness, unstable_readConfig } from "wrangler";

const source = unstable_readConfig({ config: resolve("wrangler.toml"), env: "" });
const main = resolve("dist/index.js");
const bytes = readFileSync(main);
// Run the actual production bundle with isolated KV and no AI binding. These
// checks cover HTTP routing/headers and degraded AI behavior, not model output.
const harness = createTestHarness({
  workers: [
    {
      config: {
        name: source.name,
        main,
        no_bundle: true,
        compatibility_date: source.compatibility_date,
        compatibility_flags: source.compatibility_flags,
        vars: source.vars,
        kv_namespaces: source.kv_namespaces.map((kv) => ({ ...kv, remote: false })),
      },
    },
  ],
});
try {
  await harness.listen();
  const health = await harness.fetch("/health");
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.equal((await health.json()).service, "nps-report");
  const parks = await harness.fetch("/api/parks");
  assert.equal(parks.status, 200);
  const registry = await parks.json();
  assert.equal(registry.count, 435);
  assert.equal(registry.parks.length, 435);
  assert.ok(registry.parks.every((park) => !("recipientToken" in park)));
  for (const route of ["/", "/about"]) {
    const response = await harness.fetch(route);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.ok((await response.text()).includes("ParkReport"));
  }
  const ai = await harness.fetch("/api/analyze", { method: "POST", body: "{}" });
  assert.equal(ai.status, 503);
  assert.equal((await ai.json()).error, "ai_unavailable");
  console.log(
    JSON.stringify({
      runtime: "workerd",
      bundleSha256: createHash("sha256").update(bytes).digest("hex"),
      routes: 5,
      result: "pass",
      modelRequests: 0,
    }),
  );
} finally {
  await harness.close();
}
