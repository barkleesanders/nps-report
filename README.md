# nps-report

Report broken things in US National Parks — a Hono + Cloudflare Worker **API and CLI** that wraps the National Park Service per-park "Email Us" contact form, the way [improvebayarea.com](https://improvebayarea.com) wraps SF311. Adds AI photo triage and GPS routing.

## The honest ceiling (read this first)

The NPS has **no public service-request API** like SF311 / Open311. There is no tracked case ID and no status. The only programmatic submission path is the per-park ColdFusion contact form (`sendemail.cfm`), which **emails the park**. This tool makes that path clean, structured, AI-assisted, and app-callable — but it cannot give you a ticket number, because the NPS does not issue one.

| | SF311 (improvebayarea) | NPS (this tool) |
|---|---|---|
| Public submit API | Open311 / Verint | None — wraps the email form |
| Tracked case ID | Yes | **No** (email only) |
| Status / closure | Yes | **No** |
| Structured geo | Yes (lat/lng) | **No** — coords embedded in message text |
| CAPTCHA | varies | None (honeypot + server token) |

Contract verified **2026-06-15** by fetching the live Golden Gate form. No live test submissions were made.

## How submission works

```
GET  /common/utilities/sendmail/sendemail.cfm?o=<token>&r=/<code>/contacts.htm
     → parse hidden inputs (o, hpt, r, type, submitted)   # hpt = per-load anti-spam token
POST /common/utilities/sendmail/sendemail.cfm
     x-www-form-urlencoded: hidden inputs (echoed) + email, subject, category, fullname, message
```

`o` is an obfuscated per-mailbox recipient token (stable). `category` must be one of the 9 official values; **Facilities** and **Safety** are the "broken things" buckets. Location goes in the free-text `message` (there is no geo field) — this tool auto-embeds `Coordinates: …` + a Google Maps link.

## API

| Route | Purpose |
|---|---|
| `GET /api/parks` · `GET /api/parks/:code` | Registered parks (recipient tokens redacted) |
| `GET /api/categories` | The 9 NPS report categories |
| `POST /api/locate` | `{lat,lng}` → nearest registered park + coordinate line |
| `POST /api/analyze` | `{imageBase64\|imageUrl, lat?, lng?}` → AI category + draft subject/description + nearest park |
| `POST /api/report` | Prepare (default) or send a report |

### `POST /api/report`

```jsonc
{
  "parkCode": "goga",          // OR lat+lng (auto-routes to nearest park) OR recipientToken+referrerPath
  "lat": 37.836, "lng": -122.466,
  "category": "Facilities",    // free-text accepted; "maintenance"/"hazard"/… normalized
  "subject": "Broken railing at Lands End overlook",
  "description": "The railing is cracked and loose near the main viewpoint.",
  "location": "Lands End Lookout",
  "email": "reporter@example.com",
  "fullname": "Jane Visitor",
  "send": false                // DEFAULT false = dry run; returns the exact email it would send
}
```

`send` defaults to **false** — the response contains `prepared.fields` (the exact form body) so an app can preview before delivering. Set `"send": true` to actually email the park.

## CLI

```bash
npm run report -- --list
npm run report -- --park goga --category Facilities \
  --subject "Broken railing" --description "Cracked near the overlook" \
  --location "Lands End" --email you@example.com          # dry run
npm run report -- --lat 37.836 --lng -122.466 --description "…" \
  --email you@example.com --send                          # auto-route + deliver
npm run report -- --park goga … --json                    # machine output
```

## Park registry

`src/parks.data.json` seeds Golden Gate with its verified token. Extend it:

```bash
# All parks (needs a free key from https://www.nps.gov/subjects/developer/get-started.htm):
NPS_API_KEY=… npm run harvest
# Specific parks, no key:
npm run harvest -- --codes goga,yose,grca
```

The harvester enumerates park codes via the read-only NPS Data API `/parks`, then scrapes each `/<code>/contacts.htm` for its `sendemail.cfm` recipient token + coordinates.

## Develop / deploy

```bash
npm install
npm test            # vitest — uses real captured form fixtures, never POSTs live
npm run typecheck
npm run dev         # wrangler dev
# Deploy with /ship (not from here). Workers AI binding [ai] is in wrangler.toml.
```

## Caveats

- **Success detection is provisional.** A real success page hasn't been captured (that would email a live park). `signal` is `confirmed` only on a positive phrase or a 3xx redirect; otherwise `unknown` — surface "submitted, confirmation unverified" to users.
- **Treat every send as a real visitor email.** No test/RE markers in messages — they reach actual park staff.
- Not affiliated with the National Park Service.
