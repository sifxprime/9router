// Tests for the self-healing image-capability detector added in 0.5.22.
// Covers: error-pattern recognition, cache TTL, and image stripping across
// the three body shapes we forward to upstreams (Claude, OpenAI, Gemini).
import { describe, expect, it, beforeEach } from "vitest";

import {
  hasNoImageSupport,
  markNoImageSupport,
  isImageRejectionError,
  stripImagesFromBody,
  clearImageCapabilityCache,
} from "../../open-sse/services/imageCapability.js";

describe("imageCapability — error pattern recognition", () => {
  it("recognizes Kiro IMAGE_FORMAT_UNSUPPORTED", () => {
    const body = JSON.stringify({
      message: "Bedrock error message: This model doesn't support the image content block that you provided.",
      reason: "IMAGE_FORMAT_UNSUPPORTED",
    });
    expect(isImageRejectionError(400, body)).toBe(true);
  });

  it("recognizes NVIDIA 'multimodal processing is not enabled'", () => {
    const body = JSON.stringify({
      error: { message: "multimodal processing is not enabled for this model", type: "BadRequest", code: 400 },
    });
    expect(isImageRejectionError(400, body)).toBe(true);
  });

  it("recognizes OpenAI-style 'messages.0.content must be a string'", () => {
    const body = JSON.stringify({
      error: { message: "Invalid input: 'messages.0.content' must be a string for this model" },
    });
    expect(isImageRejectionError(400, body)).toBe(true);
  });

  it("does NOT match unrelated 400 errors (e.g. param incorrect)", () => {
    const body = JSON.stringify({ error: { message: "Param Incorrect: Not supported model gpt-4" } });
    expect(isImageRejectionError(400, body)).toBe(false);
  });

  it("does NOT match non-400 statuses even with matching body text", () => {
    const body = JSON.stringify({ error: { message: "multimodal processing is not enabled" } });
    expect(isImageRejectionError(429, body)).toBe(false);
    expect(isImageRejectionError(500, body)).toBe(false);
  });

  it("handles missing/non-string body gracefully", () => {
    expect(isImageRejectionError(400, null)).toBe(false);
    expect(isImageRejectionError(400, undefined)).toBe(false);
    expect(isImageRejectionError(400, "")).toBe(false);
  });
});

describe("imageCapability — cache", () => {
  beforeEach(() => {
    clearImageCapabilityCache();
  });

  it("returns false for an unseen (provider, model) pair", () => {
    expect(hasNoImageSupport("kiro", "claude-sonnet-4.6")).toBe(false);
  });

  it("returns true after markNoImageSupport for the same pair", () => {
    markNoImageSupport("kiro", "amazon.nova-micro-v1:0");
    expect(hasNoImageSupport("kiro", "amazon.nova-micro-v1:0")).toBe(true);
  });

  it("does NOT bleed across provider boundaries", () => {
    markNoImageSupport("kiro", "amazon.nova-micro-v1:0");
    expect(hasNoImageSupport("nvidia", "amazon.nova-micro-v1:0")).toBe(false);
  });

  it("does NOT bleed across model boundaries", () => {
    markNoImageSupport("kiro", "amazon.nova-micro-v1:0");
    expect(hasNoImageSupport("kiro", "claude-sonnet-4.6")).toBe(false);
  });

  it("safely handles missing args", () => {
    markNoImageSupport(undefined, "model");
    markNoImageSupport("provider", undefined);
    expect(hasNoImageSupport(undefined, "model")).toBe(false);
    expect(hasNoImageSupport("provider", undefined)).toBe(false);
  });
});

describe("imageCapability — Claude messages format strip", () => {
  it("removes image blocks while keeping text blocks", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this image?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "FAKEBASE64" } },
          ],
        },
      ],
    };
    const stripped = stripImagesFromBody(body);
    // When only one text block remains, content is simplified to a string
    expect(stripped.messages[0].content).toBe("What is in this image?");
  });

  it("preserves string content untouched", () => {
    const body = { messages: [{ role: "user", content: "plain text only" }] };
    const stripped = stripImagesFromBody(body);
    expect(stripped.messages[0].content).toBe("plain text only");
  });

  it("replaces fully-image content with omission marker", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "X" } }],
        },
      ],
    };
    const stripped = stripImagesFromBody(body);
    expect(stripped.messages[0].content).toMatch(/image omitted/);
  });
});

describe("imageCapability — OpenAI messages format strip", () => {
  it("removes image_url blocks while keeping text", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,X" } },
          ],
        },
      ],
    };
    const stripped = stripImagesFromBody(body);
    expect(stripped.messages[0].content).toBe("Describe this");
  });
});

describe("imageCapability — Gemini contents format strip", () => {
  it("removes inlineData parts while keeping text", () => {
    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { text: "What's in this image?" },
            { inlineData: { mimeType: "image/png", data: "FAKE" } },
          ],
        },
      ],
    };
    const stripped = stripImagesFromBody(body);
    expect(stripped.contents[0].parts).toEqual([{ text: "What's in this image?" }]);
  });

  it("removes fileData parts while keeping text", () => {
    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { text: "Look at" },
            { fileData: { mimeType: "image/png", fileUri: "gs://bucket/img.png" } },
          ],
        },
      ],
    };
    const stripped = stripImagesFromBody(body);
    expect(stripped.contents[0].parts).toEqual([{ text: "Look at" }]);
  });

  it("handles Antigravity envelope body.request.contents", () => {
    const body = {
      request: {
        contents: [
          {
            role: "user",
            parts: [{ text: "hi" }, { inlineData: { mimeType: "image/png", data: "X" } }],
          },
        ],
      },
    };
    const stripped = stripImagesFromBody(body);
    expect(stripped.request.contents[0].parts).toEqual([{ text: "hi" }]);
  });

  it("inserts omission marker when all parts were images", () => {
    const body = {
      contents: [
        { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "X" } }] },
      ],
    };
    const stripped = stripImagesFromBody(body);
    expect(stripped.contents[0].parts).toEqual([
      { text: "[image omitted: model does not support vision]" },
    ]);
  });
});

describe("imageCapability — passthrough safety", () => {
  it("returns the body unchanged when no recognizable shape is present", () => {
    const body = { something: "else" };
    expect(stripImagesFromBody(body)).toEqual(body);
  });

  it("handles null/undefined gracefully", () => {
    expect(stripImagesFromBody(null)).toBe(null);
    expect(stripImagesFromBody(undefined)).toBe(undefined);
  });
});
