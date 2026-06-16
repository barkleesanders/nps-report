// Workers AI helpers — photo classification + text rewrite.
//
// Mirrors improvebayarea.com's flow: a visitor snaps a photo of the broken
// thing, a vision model classifies it into a report category and drafts the
// subject + description, then the app submits via /api/report. Model IDs +
// the messages/image_url input shape match the working improvebayarea Worker
// (verified 2026-06-15: gemma-4-26b takes messages with an image_url data URI,
// NOT the {image:[bytes],prompt} shape).

import { NPS_CATEGORIES, type NpsCategory, normalizeCategory } from "./categories";

export const VISION_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const TEXT_MODEL = "@cf/openai/gpt-oss-120b";

export interface AiSuggestion {
  category: NpsCategory;
  subject: string;
  description: string;
}

// ---- image -> data URI ------------------------------------------------------

function detectMime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return "image/webp";
  return "image/jpeg";
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function imageDataUri(bytes: Uint8Array): string {
  return `data:${detectMime(bytes)};base64,${bytesToBase64(bytes)}`;
}

// ---- model output parsing ---------------------------------------------------

function extractText(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (!raw || typeof raw !== "object") return "";
  const r = raw as {
    response?: unknown;
    description?: unknown;
    output_text?: unknown;
    result?: { response?: unknown };
    choices?: Array<{
      message?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown };
      text?: unknown;
    }>;
  };
  const ch = r.choices?.[0];
  // Reasoning models (gemma-4-26b, gpt-oss) sometimes leave `content` null and
  // put the answer in `reasoning`/`reasoning_content`; fall back to those.
  const candidates: unknown[] = [
    r.response,
    r.description,
    r.output_text,
    r.result?.response,
    ch?.message?.content,
    ch?.text,
    ch?.message?.reasoning,
    ch?.message?.reasoning_content,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return "";
}

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
Look at the photo and respond with ONLY a JSON object (no prose):
{"category": "<one of: ${NPS_CATEGORIES.join(" | ")}>", "subject": "<short title, max 80 chars>", "description": "<2-3 factual sentences describing the issue>"}
Choose "Facilities" for broken infrastructure (trails, restrooms, signs, railings, roads) and "Safety" for hazards. Do not invent details you cannot see.`;

// workers-types models chat `content` as a plain string; gemma-4-26b also
// accepts the multimodal [{type:text},{type:image_url}] array (verified against
// the working improvebayarea Worker). Cast the receiver (NOT a detached method —
// detaching ai.run loses `this` and the binding throws "#options" undefined).
type AiLike = { run: (model: string, inputs: unknown, options?: unknown) => Promise<unknown> };

/** Classify a photo into an NPS report category + draft subject/description. */
export async function analyzePhoto(ai: Ai, imageBytes: Uint8Array): Promise<AiSuggestion> {
  const raw = await (ai as unknown as AiLike).run(VISION_MODEL, {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: PROMPT },
          { type: "image_url", image_url: { url: imageDataUri(imageBytes) } },
        ],
      },
    ],
    max_tokens: 700,
    reasoning_effort: "low",
  });
  const parsed = extractJson(extractText(raw)) ?? {};
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
  const raw = await (ai as unknown as AiLike).run(TEXT_MODEL, {
    messages: [
      {
        role: "system",
        content:
          "Rewrite a park-issue report to be clear, factual, and concise for park staff. " +
          'Respond with ONLY JSON: {"subject": "<max 80 chars>", "description": "<2-3 sentences>"}. ' +
          "Do not add facts the user did not provide.",
      },
      {
        role: "user",
        content: `Category: ${input.category}\nSubject: ${input.subject}\nDescription: ${input.description}`,
      },
    ],
    reasoning_effort: "low",
    max_tokens: 400,
  });
  const parsed = extractJson(extractText(raw)) ?? {};
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
