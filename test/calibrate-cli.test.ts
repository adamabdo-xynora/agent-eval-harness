import { describe, expect, it } from "vitest";

import { parseDotEnv, pickArgs, resolveApiKey } from "../src/calibrate-cli.js";

/**
 * These tests exercise the CLI's pure helpers, never the process entry point. No test
 * here reads `process.env`, spawns a shell, or touches the network: every environment
 * is an explicit record passed in as an argument, which is the reason `resolveApiKey`
 * takes one instead of reading ambient state.
 *
 * A decoy key runs through the failure paths so the "never print the key" rule is an
 * assertion rather than a comment.
 */

/** Looks enough like a real key to be worth catching if it ever leaks into a message. */
const DECOY_KEY = "sk-ant-decoy-do-not-log-9f3c2b";

const PLACEHOLDER = "<paste-your-key-here>";

describe("parseDotEnv", () => {
  it("parses a plain KEY=VALUE line", () => {
    expect(parseDotEnv("ANTHROPIC_API_KEY=abc123")).toEqual({ ANTHROPIC_API_KEY: "abc123" });
  });

  it("ignores blank lines, whitespace-only lines, and # comments", () => {
    const content = [
      "# the key below is a fake",
      "",
      "   ",
      "ANTHROPIC_API_KEY=abc123",
      "   # indented comment",
      "OTHER=xyz",
    ].join("\n");

    expect(parseDotEnv(content)).toEqual({ ANTHROPIC_API_KEY: "abc123", OTHER: "xyz" });
  });

  it("strips one pair of surrounding double or single quotes", () => {
    const parsed = parseDotEnv(['DOUBLE="abc123"', "SINGLE='abc123'"].join("\n"));

    expect(parsed).toEqual({ DOUBLE: "abc123", SINGLE: "abc123" });
  });

  it("leaves unmatched and interior quotes alone", () => {
    const parsed = parseDotEnv(['UNMATCHED="abc', "INTERIOR=ab\"c\"d", "MIXED=\"abc'"].join("\n"));

    expect(parsed).toEqual({ UNMATCHED: '"abc', INTERIOR: 'ab"c"d', MIXED: "\"abc'" });
  });

  it("lets a later duplicate key win, like a shell sourcing the file top to bottom", () => {
    expect(parseDotEnv(["K=first", "K=second", "K=third"].join("\n"))).toEqual({ K: "third" });
  });

  it("tolerates values containing '=' by splitting on the first one only", () => {
    // Base64-ish values end in `=` padding; splitting on every `=` would truncate them.
    const parsed = parseDotEnv(["TOKEN=a=b=c", "PADDED=c2VjcmV0=="].join("\n"));

    expect(parsed).toEqual({ TOKEN: "a=b=c", PADDED: "c2VjcmV0==" });
  });

  it("trims surrounding whitespace from keys and values", () => {
    expect(parseDotEnv("  ANTHROPIC_API_KEY  =   abc123   ")).toEqual({
      ANTHROPIC_API_KEY: "abc123",
    });
  });

  it("skips lines with no '=' and lines with an empty key", () => {
    expect(parseDotEnv(["JUST_A_WORD", "=orphan-value", "GOOD=yes"].join("\n"))).toEqual({
      GOOD: "yes",
    });
  });

  it("handles CRLF line endings", () => {
    expect(parseDotEnv("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });

  it("returns an empty record for empty content", () => {
    expect(parseDotEnv("")).toEqual({});
  });
});

describe("resolveApiKey", () => {
  it("takes the key from the environment when it is set", () => {
    expect(resolveApiKey({ ANTHROPIC_API_KEY: "env-key" }, null)).toEqual({ key: "env-key" });
  });

  it("falls back to .env when the environment does not carry the key", () => {
    const result = resolveApiKey({}, "ANTHROPIC_API_KEY=dotenv-key");

    expect(result).toEqual({ key: "dotenv-key" });
  });

  it("lets the environment variable win over .env", () => {
    // CI injects a secret into the environment; a checked-out .env must not shadow it.
    const result = resolveApiKey({ ANTHROPIC_API_KEY: "env-key" }, "ANTHROPIC_API_KEY=dotenv-key");

    expect(result).toEqual({ key: "env-key" });
  });

  it("treats an empty or whitespace-only environment value as unset and falls back", () => {
    expect(resolveApiKey({ ANTHROPIC_API_KEY: "   " }, "ANTHROPIC_API_KEY=dotenv-key")).toEqual({
      key: "dotenv-key",
    });
  });

  it("trims the resolved key from either source", () => {
    expect(resolveApiKey({ ANTHROPIC_API_KEY: "  env-key  " }, null)).toEqual({ key: "env-key" });
    expect(resolveApiKey({}, 'ANTHROPIC_API_KEY="  dotenv-key  "')).toEqual({ key: "dotenv-key" });
  });

  it("errors when the key is missing everywhere", () => {
    const result = resolveApiKey({}, null);

    expect(result).toEqual({ error: expect.stringContaining("ANTHROPIC_API_KEY") });
    expect("key" in result).toBe(false);
  });

  it("errors when .env exists but carries no ANTHROPIC_API_KEY", () => {
    const result = resolveApiKey({}, "SOMETHING_ELSE=1");

    expect("error" in result).toBe(true);
  });

  it("rejects the placeholder with an error that points at .env", () => {
    const result = resolveApiKey({}, `ANTHROPIC_API_KEY=${PLACEHOLDER}`);

    expect(result).toEqual({ error: expect.stringContaining(".env") });
  });

  it("rejects the placeholder even when it arrives via the environment", () => {
    // A shell that exported the placeholder is the same operator mistake as an
    // unedited .env, and deserves the same message rather than a confusing success.
    const result = resolveApiKey({ ANTHROPIC_API_KEY: PLACEHOLDER }, null);

    expect(result).toEqual({ error: expect.stringContaining(".env") });
  });

  it("never leaks the key value from the environment into an error string", () => {
    // The environment holds the decoy AND the placeholder wins the precedence check,
    // so the rejection path has a real-looking key in scope while it builds a message.
    const result = resolveApiKey(
      { ANTHROPIC_API_KEY: PLACEHOLDER, DECOY: DECOY_KEY },
      `ANTHROPIC_API_KEY=${DECOY_KEY}`,
    );

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).not.toContain(DECOY_KEY);
      expect(result.error).not.toContain("decoy");
    }
  });

  it("never leaks the key value from .env into an error string", () => {
    const result = resolveApiKey({}, [`ANTHROPIC_API_KEY=${PLACEHOLDER}`, `SPARE=${DECOY_KEY}`].join("\n"));

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).not.toContain(DECOY_KEY);
    }
  });

  it("does not echo an unrecognised environment value in the missing-key error", () => {
    const result = resolveApiKey({ ANTHROPIC_KEY_TYPO: DECOY_KEY }, null);

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).not.toContain(DECOY_KEY);
    }
  });
});

describe("pickArgs", () => {
  it("defaults casesDir to \"cases\" and leaves model unset", () => {
    const args = pickArgs([]);

    expect(args.casesDir).toBe("cases");
    expect(args.model).toBeUndefined();
  });

  it("takes a positional argument as casesDir", () => {
    expect(pickArgs(["fixtures/golden"])).toEqual({ casesDir: "fixtures/golden" });
  });

  it("captures --model", () => {
    expect(pickArgs(["--model", "claude-opus-5"])).toEqual({
      casesDir: "cases",
      model: "claude-opus-5",
    });
  });

  it("captures --model=<id>", () => {
    expect(pickArgs(["--model=claude-opus-5"])).toEqual({
      casesDir: "cases",
      model: "claude-opus-5",
    });
  });

  it("accepts a positional and a flag in either order", () => {
    const expected = { casesDir: "fixtures", model: "claude-opus-5" };

    expect(pickArgs(["fixtures", "--model", "claude-opus-5"])).toEqual(expected);
    expect(pickArgs(["--model", "claude-opus-5", "fixtures"])).toEqual(expected);
  });

  it("throws when --model has no value", () => {
    expect(() => pickArgs(["--model"])).toThrow(/--model requires a model id/);
    expect(() => pickArgs(["--model="])).toThrow(/--model requires a model id/);
  });

  // Rejecting rather than ignoring is the deliberate choice: a calibration run spends
  // real model calls, and a typo'd flag would quietly measure the wrong model and then
  // record the wrong id in the run artifact.
  it("rejects unknown flags instead of ignoring them", () => {
    expect(() => pickArgs(["--modle", "claude-opus-5"])).toThrow(/unknown option "--modle"/);
    expect(() => pickArgs(["-m", "claude-opus-5"])).toThrow(/unknown option "-m"/);
  });

  it("rejects a second positional argument", () => {
    expect(() => pickArgs(["cases", "extra"])).toThrow(/unexpected extra argument "extra"/);
  });

  it("does not treat a --model value that looks like a flag as an unknown option", () => {
    // The value is consumed by --model, so the loop never inspects it as a token.
    expect(pickArgs(["--model", "--weird-model-id"])).toEqual({
      casesDir: "cases",
      model: "--weird-model-id",
    });
  });
});
