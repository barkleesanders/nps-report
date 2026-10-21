import { describe, expect, it, vi } from "vitest";
import { analyzePhoto, rewriteReportText, TEXT_MODEL, VISION_MODEL } from "./ai";

describe("Workers AI contract", () => {
  it("uses Gemma's thinking switch and preserves multimodal image content", async () => {
    const run = vi.fn();
    run.mockResolvedValue({
      response:
        '{"category":"Facilities","subject":"Broken railing","description":"A railing has a visible gap."}',
    });
    const result = await analyzePhoto({ run }, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(result).toEqual({
      category: "Facilities",
      subject: "Broken railing",
      description: "A railing has a visible gap.",
    });
    expect(run).toHaveBeenCalledWith(
      VISION_MODEL,
      expect.objectContaining({
        chat_template_kwargs: { enable_thinking: false },
        messages: [
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "image_url",
                image_url: { url: "data:image/png;base64,iVBORw==" },
              }),
            ]),
          }),
        ],
      }),
    );
    expect(run.mock.calls[0]?.[1]).not.toHaveProperty("reasoning_effort");
  });

  it("keeps the existing fallback for malformed output", async () => {
    const run = vi.fn();
    run.mockResolvedValue({ response: "not json" });
    expect(await analyzePhoto({ run }, new Uint8Array([0xff, 0xd8]))).toMatchObject({
      subject: "Reported park condition",
    });
  });

  it("retains GPT-OSS reasoning settings for text rewriting", async () => {
    const run = vi.fn();
    run.mockResolvedValue({
      response: '{"subject":"Clear title","description":"Provided facts."}',
    });
    expect(
      await rewriteReportText(
        { run },
        { category: "Safety", subject: "Title", description: "Facts" },
      ),
    ).toEqual({ subject: "Clear title", description: "Provided facts." });
    expect(run).toHaveBeenCalledWith(
      TEXT_MODEL,
      expect.objectContaining({ reasoning_effort: "low" }),
    );
  });
});
