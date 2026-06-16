#!/usr/bin/env tsx
// Harvest the park mailbox registry into src/parks.data.json.
//
// Two modes:
//   Full:    NPS_API_KEY=... npm run harvest
//            -> enumerate all parks via the read-only NPS Data API /parks,
//               then scrape each /<code>/contacts.htm for its sendemail.cfm
//               recipient token + latLong.
//   Subset:  npm run harvest -- --codes goga,yose,grca
//            -> scrape only those codes (no API key needed; name/coords
//               best-effort from the contacts page).
//
// Network-bound; not run in tests. Writes the merged registry back to disk.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(here, "../src/parks.data.json");
const UA = "nps-report-harvester/0.1 (+https://github.com/)";

interface ParkRecord {
  code: string;
  name: string;
  referrerPath: string;
  recipientToken: string;
  mailbox?: string;
  states?: string[];
  lat?: number;
  lng?: number;
}

async function listAllParkCodes(
  apiKey: string,
): Promise<Array<{ code: string; name: string; states: string[]; lat?: number; lng?: number }>> {
  const out: Array<{ code: string; name: string; states: string[]; lat?: number; lng?: number }> =
    [];
  let start = 0;
  const limit = 50;
  for (;;) {
    const url = `https://developer.nps.gov/api/v1/parks?limit=${limit}&start=${start}&api_key=${apiKey}`;
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error(`Data API HTTP ${r.status}`);
    const data = (await r.json()) as {
      total: string;
      data: Array<{
        parkCode: string;
        fullName: string;
        states: string;
        latLong?: string;
      }>;
    };
    for (const p of data.data) {
      const m = p.latLong?.match(/lat:([-\d.]+),\s*long:([-\d.]+)/);
      out.push({
        code: p.parkCode,
        name: p.fullName,
        states: p.states ? p.states.split(",") : [],
        lat: m ? Number(m[1]) : undefined,
        lng: m ? Number(m[2]) : undefined,
      });
    }
    start += limit;
    if (start >= Number(data.total) || data.data.length === 0) break;
  }
  return out;
}

// Pull the first sendemail.cfm recipient token from a park's contacts page.
async function scrapeToken(code: string): Promise<string | null> {
  const url = `https://www.nps.gov/${code}/contacts.htm`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) return null;
  const html = await r.text();
  const m = html.match(/sendemail\.cfm\?o=([0-9A-F]+)/i);
  return m?.[1] ?? null;
}

async function main() {
  const argv = process.argv.slice(2);
  const codesFlag = argv.indexOf("--codes");
  const codesArg = codesFlag !== -1 ? argv[codesFlag + 1] : undefined;
  const explicitCodes = codesArg ? codesArg.split(",").map((s) => s.trim().toLowerCase()) : null;

  const apiKey = process.env.NPS_API_KEY;
  let catalog: Array<{ code: string; name: string; states: string[]; lat?: number; lng?: number }>;

  if (explicitCodes) {
    catalog = explicitCodes.map((code) => ({ code, name: code.toUpperCase(), states: [] }));
  } else if (apiKey) {
    console.error("Enumerating parks via NPS Data API…");
    catalog = await listAllParkCodes(apiKey);
    console.error(`  ${catalog.length} parks found.`);
  } else {
    console.error("No NPS_API_KEY and no --codes. Set the key or pass --codes goga,yose.");
    process.exit(1);
  }

  const existing = JSON.parse(readFileSync(DATA_PATH, "utf8")) as {
    _meta: unknown;
    parks: ParkRecord[];
  };
  const byCode = new Map(existing.parks.map((p) => [p.code.toLowerCase(), p]));

  let added = 0;
  let updated = 0;
  for (const park of catalog) {
    const token = await scrapeToken(park.code);
    if (!token) {
      console.error(`  ${park.code}: no contact token (skipped)`);
      continue;
    }
    const record: ParkRecord = {
      code: park.code,
      name: park.name,
      referrerPath: `/${park.code}/contacts.htm`,
      recipientToken: token,
      mailbox: "general",
      states: park.states.length ? park.states : undefined,
      lat: park.lat,
      lng: park.lng,
    };
    if (byCode.has(park.code.toLowerCase())) updated++;
    else added++;
    byCode.set(park.code.toLowerCase(), record);
    console.error(`  ${park.code}: ${token.slice(0, 12)}…`);
    await new Promise((res) => setTimeout(res, 250)); // be polite to nps.gov
  }

  const merged = {
    _meta: {
      note: "Park mailbox registry. recipientToken is the obfuscated o= value from each park's /contacts.htm 'Email Us' link.",
      verified: new Date().toISOString().slice(0, 10),
      source: "https://www.nps.gov/<code>/contacts.htm sendemail.cfm links",
    },
    parks: [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code)),
  };
  writeFileSync(DATA_PATH, `${JSON.stringify(merged, null, 2)}\n`);
  console.error(`\nWrote ${merged.parks.length} parks (${added} added, ${updated} updated).`);
}

main();
