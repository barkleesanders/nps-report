// NPS contact-form categories.
//
// These are the EXACT <option value="…"> values from the live NPS "Email Us"
// form (sendemail.cfm), verified 2026-06-15 against
// https://www.nps.gov/common/utilities/sendmail/sendemail.cfm. Do not invent
// new values — the ColdFusion handler echoes the category into the email and an
// unknown value would look wrong to park staff.

export const NPS_CATEGORIES = [
  "Accessibility",
  "Digital Experience",
  "Facilities",
  "Information",
  "Permits",
  "Programs",
  "Safety",
  "User Fees",
  "Other",
] as const;

export type NpsCategory = (typeof NPS_CATEGORIES)[number];

// Map common user/app phrasings onto an official category. "Broken things" —
// the whole point of this tool — map onto Facilities (infrastructure) or
// Safety (hazard). Everything unknown falls through to Other.
const ALIASES: Record<string, NpsCategory> = {
  facilities: "Facilities",
  facility: "Facilities",
  maintenance: "Facilities",
  broken: "Facilities",
  damage: "Facilities",
  damaged: "Facilities",
  infrastructure: "Facilities",
  restroom: "Facilities",
  bathroom: "Facilities",
  trail: "Facilities",
  road: "Facilities",
  sign: "Facilities",
  vandalism: "Facilities",
  graffiti: "Facilities",
  safety: "Safety",
  hazard: "Safety",
  dangerous: "Safety",
  danger: "Safety",
  unsafe: "Safety",
  injury: "Safety",
  accessibility: "Accessibility",
  ada: "Accessibility",
  wheelchair: "Accessibility",
  information: "Information",
  info: "Information",
  question: "Information",
  permit: "Permits",
  permits: "Permits",
  program: "Programs",
  programs: "Programs",
  ranger: "Programs",
  fee: "User Fees",
  fees: "User Fees",
  "user fees": "User Fees",
  payment: "User Fees",
  website: "Digital Experience",
  app: "Digital Experience",
  "digital experience": "Digital Experience",
  other: "Other",
};

/** Resolve any user/app category string to an official NPS category. */
export function normalizeCategory(input: string | undefined | null): NpsCategory {
  if (!input) return "Facilities";
  const s = input.trim().toLowerCase();
  // 1) Exact official match.
  const exact = NPS_CATEGORIES.find((c) => c.toLowerCase() === s);
  if (exact) return exact;
  // 2) Exact alias match.
  if (ALIASES[s]) return ALIASES[s];
  // 3) Keyword-in-phrase match (e.g. "broken railing" -> Facilities,
  //    "dangerous cliff edge" -> Safety). Iterate in alias insertion order so
  //    Facilities/Safety buckets win for "broken-thing" phrasings.
  const words = new Set(s.split(/[^a-z]+/).filter(Boolean));
  for (const [key, cat] of Object.entries(ALIASES)) {
    if (key.includes(" ")) {
      if (s.includes(key)) return cat;
    } else if (words.has(key)) {
      return cat;
    }
  }
  return "Other";
}

export function isNpsCategory(value: string): value is NpsCategory {
  return (NPS_CATEGORIES as readonly string[]).includes(value);
}
