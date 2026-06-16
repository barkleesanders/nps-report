// Workers AI helpers — photo classification + text rewrite.
//
// Mirrors improvebayarea.com's flow: a visitor snaps a photo of the broken
// thing, a vision model classifies it into a report category and drafts the
// subject + description, then the app submits via /api/report. Model IDs match
// the working improvebayarea Worker (verified 2026-06-15).

import { NPS_CATEGORIES, type NpsCategory, normalizeCategory } from "./categories";

export const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
export const TEXT_MODEL = "@cf/google/gemma-4-26b-a4b-it";

export interface AiSuggestion {
  category: NpsCategory;
  subject: string;
  description: string;
}

// Pull the first JSON object out of a model's free-text reply.
function extractJson(text: string): Record<string, unknown> | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const PROMPT = `You are helping a national-park visitor report a broken or unsafe condition.
Look at the photo and respond with ONLY a JSON object:
{"category": <one of ${NPS_CATEGORIES.join(" | ")}>, "subject": <short title, max 80 chars>, "description": <2-3 sentences describing the issue factually>}
Pick "Facilities" for broken infrastructure (trails, restrooms, signs, railings, roads) and "Safety" for hazards. Do not invent details you cannot see.`;

/** Classify a photo into an NPS report category + draft subject/description. */
export async function analyzePhoto(ai: Ai, imageBytes: Uint8Array): Promise<AiSuggestion> {
  const raw = (await ai.run(VISION_MODEL, {
    image: Array.from(imageBytes),
    prompt: PROMPT,
    max_tokens: 512,
  })) as { response?: string };
  const parsed = extractJson(raw.response ?? "") ?? {};
  return {
    category: normalizeCategory(typeof parsed.category === "string" ? parsed.category : undefined),
    subject:
      typeof parsed.subject === "string" && parsed.subject.trim()
        ? parsed.subject.trim().slice(0, 120)
        : "Reported park condition",
    description:
      typeof parsed.description === "string" && parsed.description.trim()
        ? parsed.description.trim()
        : "A visitor reported a condition in the park (see attached photo).",
  };
}

/** Tidy a user's raw subject/description for a given category. */
export async function rewriteReportText(
  ai: Ai,
  input: { subject: string; description: string; category: NpsCategory },
): Promise<{ subject: string; description: string }> {
  const raw = (await ai.run(TEXT_MODEL, {
    messages: [
      {
        role: "system",
        content:
          "Rewrite a park-issue report to be clear, factual, and concise for park staff. " +
          'Respond with ONLY JSON: {"subject": <max 80 chars>, "description": <2-3 sentences>}. ' +
          "Do not add facts the user did not provide.",
      },
      {
        role: "user",
        content: `Category: ${input.category}\nSubject: ${input.subject}\nDescription: ${input.description}`,
      },
    ],
    max_tokens: 400,
  })) as { response?: string };
  const parsed = extractJson(raw.response ?? "") ?? {};
  return {
    subject:
      typeof parsed.subject === "string" && parsed.subject.trim()
        ? parsed.subject.trim().slice(0, 120)
        : input.subject,
    description:
      typeof parsed.description === "string" && parsed.description.trim()
        ? parsed.description.trim()
        : input.description,
  };
}
