#!/usr/bin/env tsx

// CLI for submitting an NPS park report. Dual-mode output (human + --json).
// Dry-run by default; pass --send to actually email the park.
//
//   npm run report -- --park goga --category Facilities \
//     --subject "Broken railing" --description "Cracked near the overlook" \
//     --location "Lands End" --email you@example.com
//
//   npm run report -- --lat 37.836 --lng -122.466 --description "..." \
//     --email you@example.com --send

import { nearestPark } from "../src/geo";
import { submitReport } from "../src/nps";
import { getPark, listParks } from "../src/parks";

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

function str(f: Flags, k: string): string | undefined {
  return typeof f[k] === "string" ? (f[k] as string) : undefined;
}

async function main() {
  const f = parseArgs(process.argv.slice(2));
  const json = f.json === true;

  if (f.help === true || f.list === true) {
    if (f.list === true) {
      const parks = listParks().map((p) => `  ${p.code.padEnd(8)} ${p.name}`);
      console.log("Registered parks:\n" + parks.join("\n"));
      return;
    }
    console.log(
      "Usage: report --park <code>|--lat <n> --lng <n> --subject <s> --description <s> --email <e> [--category <c>] [--location <s>] [--observed <s>] [--name <s>] [--send] [--json] [--list]",
    );
    return;
  }

  // Resolve target.
  let recipientToken = str(f, "token");
  let referrerPath = str(f, "referrer");
  const parkCode = str(f, "park");
  const lat = str(f, "lat") ? Number(str(f, "lat")) : undefined;
  const lng = str(f, "lng") ? Number(str(f, "lng")) : undefined;

  if (parkCode) {
    const park = getPark(parkCode);
    if (!park) {
      console.error(`Unknown park code "${parkCode}". Try --list.`);
      process.exit(1);
    }
    recipientToken = park.recipientToken;
    referrerPath = park.referrerPath;
  } else if (!recipientToken && lat !== undefined && lng !== undefined) {
    const near = nearestPark(lat, lng);
    if (!near) {
      console.error(
        "No registered park near those coordinates. Pass --park or --token/--referrer.",
      );
      process.exit(1);
    }
    recipientToken = near.park.recipientToken;
    referrerPath = near.park.referrerPath;
    if (!json)
      console.error(`Auto-routed to ${near.park.name} (${Math.round(near.distanceKm)} km).`);
  }

  if (!recipientToken || !referrerPath) {
    console.error("Provide --park, or --token + --referrer, or --lat + --lng near a known park.");
    process.exit(1);
  }

  const send = f.send === true;
  try {
    const result = await submitReport(
      {
        recipientToken,
        referrerPath,
        category: str(f, "category"),
        subject: str(f, "subject") ?? "",
        description: str(f, "description") ?? "",
        location: str(f, "location"),
        lat,
        lng,
        observedAt: str(f, "observed"),
        email: str(f, "email") ?? "",
        fullname: str(f, "name"),
      },
      { send },
    );

    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`\n${result.dryRun ? "DRY RUN" : "SENT"} — ${result.note}`);
    console.log(`  category: ${result.prepared.fields.category ?? ""}`);
    console.log(`  subject:  ${result.prepared.fields.subject ?? ""}`);
    console.log(`  message:\n${(result.prepared.fields.message ?? "").replace(/^/gm, "    ")}`);
    if (!send) console.log("\n  (nothing was emailed — add --send to deliver)");
  } catch (err) {
    if (json) console.log(JSON.stringify({ error: String(err) }, null, 2));
    else console.error(`Error: ${err}`);
    process.exit(1);
  }
}

main();
