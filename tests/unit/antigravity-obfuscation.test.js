// Tests for antigravityObfuscation (0.5.29).
import { describe, expect, it, beforeEach } from "vitest";
import {
  obfuscateSensitiveWords,
  obfuscateBodyStrings,
  setAntigravitySensitiveWords,
  getAntigravitySensitiveWords,
} from "../../open-sse/services/antigravityObfuscation.js";

const ZWJ = "‍";

describe("obfuscateSensitiveWords", () => {
  beforeEach(() => setAntigravitySensitiveWords([]));

  it("inserts ZWJ after first char of a sensitive word", () => {
    setAntigravitySensitiveWords(["claude-code"]);
    expect(obfuscateSensitiveWords("running on claude-code now")).toBe(`running on c${ZWJ}laude-code now`);
  });

  it("is case-insensitive in matching but preserves original case", () => {
    setAntigravitySensitiveWords(["cursor"]);
    expect(obfuscateSensitiveWords("Cursor IDE")).toBe(`C${ZWJ}ursor IDE`);
    expect(obfuscateSensitiveWords("CURSOR")).toBe(`C${ZWJ}URSOR`);
  });

  it("obfuscates every occurrence", () => {
    setAntigravitySensitiveWords(["cursor"]);
    const out = obfuscateSensitiveWords("cursor + cursor + cursor");
    expect(out.match(new RegExp(`c${ZWJ}ursor`, "g")).length).toBe(3);
  });

  it("ignores single-char words gracefully", () => {
    setAntigravitySensitiveWords(["a"]);
    expect(obfuscateSensitiveWords("a quick test")).toBe("a quick test");
  });

  it("returns the input unchanged when no words configured", () => {
    setAntigravitySensitiveWords([]);
    // Defaults restored — should obfuscate "claude-code" anyway via default list
    const out = obfuscateSensitiveWords("foo");
    expect(out).toBe("foo");
  });

  it("default word list includes common ones", () => {
    setAntigravitySensitiveWords([]); // restore defaults
    const defaults = getAntigravitySensitiveWords();
    expect(defaults).toContain("claude-code");
    expect(defaults).toContain("cursor");
    expect(defaults).toContain("opencode");
  });

  it("handles non-string input gracefully", () => {
    expect(obfuscateSensitiveWords(null)).toBeNull();
    expect(obfuscateSensitiveWords(undefined)).toBeUndefined();
    expect(obfuscateSensitiveWords(123)).toBe(123);
  });
});

describe("obfuscateBodyStrings — recursive walk", () => {
  beforeEach(() => setAntigravitySensitiveWords(["cursor"]));

  it("walks arrays of strings", () => {
    const out = obfuscateBodyStrings(["hello cursor", "no match"]);
    expect(out[0]).toBe(`hello c${ZWJ}ursor`);
    expect(out[1]).toBe("no match");
  });

  it("walks nested objects", () => {
    const body = { messages: [{ role: "user", content: "I'm using cursor" }] };
    const out = obfuscateBodyStrings(body);
    expect(out.messages[0].content).toBe(`I'm using c${ZWJ}ursor`);
  });

  it("never mutates the input", () => {
    const orig = { x: "use cursor here" };
    const _out = obfuscateBodyStrings(orig);
    expect(orig.x).toBe("use cursor here");
  });

  it("respects maxDepth", () => {
    const deep = { a: { b: { c: { d: "deep cursor here" } } } };
    const out = obfuscateBodyStrings(deep, 2);
    // At depth 2, the inner "cursor" is NOT obfuscated
    expect(out.a.b.c.d).toBe("deep cursor here");
  });

  it("passes through primitives unchanged", () => {
    expect(obfuscateBodyStrings(42)).toBe(42);
    expect(obfuscateBodyStrings(null)).toBe(null);
    expect(obfuscateBodyStrings(true)).toBe(true);
  });
});
