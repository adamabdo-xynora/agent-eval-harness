import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CRITERIA,
  loadGoldenSet,
  parseGoldenCase,
  type GoldenCase,
} from "../src/golden.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CASES_DIR = join(REPO_ROOT, "cases");

/** Temp dirs created during a test, torn down in afterEach. */
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "golden-set-test-"));
  tempDirs.push(dir);
  return dir;
}

/** A minimally valid case, spread-and-override to build invalid variants. */
function validCaseObject(id = "case_x"): unknown {
  return {
    transcript: {
      id,
      description: "A minimal valid case used as a fixture.",
      messages: [
        { role: "user", content: "Can you move my 3pm?" },
        { role: "assistant", content: "Moved it to 4pm and notified attendees." },
      ],
    },
    labels: [
      {
        criterion: "task_completion",
        verdict: "pass",
        rationale: "The agent moved the meeting the user named and confirmed the new time.",
      },
    ],
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("loadGoldenSet on the real cases/ directory", () => {
  it("returns exactly eight cases with ids case_001..case_008 in sorted order", async () => {
    const cases = await loadGoldenSet(CASES_DIR);

    expect(cases).toHaveLength(8);
    expect(cases.map((c) => c.transcript.id)).toEqual([
      "case_001",
      "case_002",
      "case_003",
      "case_004",
      "case_005",
      "case_006",
      "case_007",
      "case_008",
    ]);
  });

  it("labels every case on all three criteria with non-empty rationales", async () => {
    const cases = await loadGoldenSet(CASES_DIR);
    const criterionIds = CRITERIA.map((c) => c.id);

    for (const goldenCase of cases) {
      const labeled = goldenCase.labels.map((l) => l.criterion).sort();
      expect(labeled, `${goldenCase.transcript.id} criteria`).toEqual(
        [...criterionIds].sort(),
      );

      for (const label of goldenCase.labels) {
        expect(
          label.rationale.trim().length,
          `${goldenCase.transcript.id}/${label.criterion} rationale`,
        ).toBeGreaterThan(0);
        expect(["pass", "fail"]).toContain(label.verdict);
      }
    }
  });

  it("gives every case a description and a non-empty transcript", async () => {
    const cases = await loadGoldenSet(CASES_DIR);

    for (const goldenCase of cases) {
      expect(goldenCase.transcript.description.trim().length).toBeGreaterThan(0);
      expect(goldenCase.transcript.messages.length).toBeGreaterThan(0);
    }
  });

  it("covers the intended verdict mix: injection refused passes safety, injection complied fails it", async () => {
    const cases = await loadGoldenSet(CASES_DIR);
    const verdict = (id: string, criterion: string): string | undefined =>
      cases
        .find((c) => c.transcript.id === id)
        ?.labels.find((l) => l.criterion === criterion)?.verdict;

    expect(verdict("case_005", "safety")).toBe("fail");
    expect(verdict("case_006", "safety")).toBe("pass");
    expect(verdict("case_003", "task_completion")).toBe("fail");
    expect(verdict("case_007", "task_completion")).toBe("fail");
    expect(verdict("case_004", "grounding")).toBe("fail");
    expect(verdict("case_008", "grounding")).toBe("pass");
  });
});

describe("parseGoldenCase", () => {
  it("accepts a well-formed case", () => {
    const parsed: GoldenCase = parseGoldenCase(validCaseObject(), "fixtures/ok.json");

    expect(parsed.transcript.id).toBe("case_x");
    expect(parsed.transcript.messages).toHaveLength(2);
    expect(parsed.labels[0]?.criterion).toBe("task_completion");
  });

  it("rejects an unknown criterion id and names the valid ids", () => {
    const raw = validCaseObject();
    (raw as { labels: { criterion: string }[] }).labels[0]!.criterion = "helpfulness";

    expect(() => parseGoldenCase(raw, "cases/case_003.json")).toThrowError(
      /labels\[0\]\.criterion is not a known criterion id, got "helpfulness"; valid ids are task_completion, grounding, safety/,
    );
  });

  it('rejects verdict "maybe" with the failing field path', () => {
    const raw = validCaseObject();
    (raw as { labels: { verdict: string }[] }).labels[0]!.verdict = "maybe";

    expect(() => parseGoldenCase(raw, "cases/case_003.json")).toThrowError(
      'cases/case_003.json: labels[0].verdict must be "pass" or "fail", got "maybe"',
    );
  });

  it("rejects an empty rationale", () => {
    const raw = validCaseObject();
    (raw as { labels: { rationale: string }[] }).labels[0]!.rationale = "   ";

    expect(() => parseGoldenCase(raw, "cases/case_003.json")).toThrowError(
      "cases/case_003.json: labels[0].rationale must be a non-empty string",
    );
  });

  it("rejects an empty messages array", () => {
    const raw = validCaseObject();
    (raw as { transcript: { messages: unknown[] } }).transcript.messages = [];

    expect(() => parseGoldenCase(raw, "cases/case_003.json")).toThrowError(
      "cases/case_003.json: transcript.messages must contain at least one message",
    );
  });

  it("rejects a duplicate criterion within one case", () => {
    const raw = validCaseObject();
    const labels = (raw as { labels: unknown[] }).labels;
    labels.push({
      criterion: "task_completion",
      verdict: "fail",
      rationale: "A second, conflicting label for the same criterion.",
    });

    expect(() => parseGoldenCase(raw, "cases/case_003.json")).toThrowError(
      /labels\[1\]\.criterion duplicates labels\[0\]\.criterion \("task_completion"\)/,
    );
  });

  it("rejects a message with a role other than user or assistant", () => {
    const raw = validCaseObject();
    (raw as { transcript: { messages: unknown[] } }).transcript.messages[0] = {
      role: "system",
      content: "You are a helpful assistant.",
    };

    expect(() => parseGoldenCase(raw, "cases/case_003.json")).toThrowError(
      'cases/case_003.json: transcript.messages[0].role must be "user" or "assistant", got "system"',
    );
  });

  it("rejects non-string message content", () => {
    const raw = validCaseObject();
    (raw as { transcript: { messages: { content: unknown }[] } }).transcript.messages[1]!.content = 42;

    expect(() => parseGoldenCase(raw, "cases/case_003.json")).toThrowError(
      "cases/case_003.json: transcript.messages[1].content must be a string, got 42",
    );
  });

  it("rejects a case with no labels", () => {
    const raw = validCaseObject();
    (raw as { labels: unknown[] }).labels = [];

    expect(() => parseGoldenCase(raw, "cases/case_003.json")).toThrowError(
      "cases/case_003.json: labels must contain at least one human label",
    );
  });

  it("prefixes every error with the sourcePath it was given", () => {
    const sourcePath = "some/nested/path/case_042.json";

    expect(() => parseGoldenCase(null, sourcePath)).toThrowError(
      new RegExp(`^${sourcePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `),
    );

    try {
      parseGoldenCase({ transcript: { id: "", description: "d", messages: [] } }, sourcePath);
      expect.unreachable("expected parseGoldenCase to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(sourcePath);
    }
  });
});

describe("loadGoldenSet failure modes", () => {
  it("throws naming the malformed file and returns no partial set", async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, "case_001.json"),
      JSON.stringify(validCaseObject("case_001")),
      "utf8",
    );
    const badPath = join(dir, "case_002.json");
    const malformed = validCaseObject("case_002");
    (malformed as { labels: { verdict: string }[] }).labels[0]!.verdict = "maybe";
    await writeFile(badPath, JSON.stringify(malformed), "utf8");

    // The valid case_001 must NOT come back on its own: a golden set that silently
    // shrinks moves every downstream agreement statistic without anyone noticing.
    await expect(loadGoldenSet(dir)).rejects.toThrowError(badPath);
    await expect(loadGoldenSet(dir)).rejects.toThrowError(
      `${badPath}: labels[0].verdict must be "pass" or "fail", got "maybe"`,
    );
  });

  it("throws on a file that is not valid JSON at all, naming the file", async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, "case_001.json"),
      JSON.stringify(validCaseObject("case_001")),
      "utf8",
    );
    const badPath = join(dir, "case_002.json");
    await writeFile(badPath, "{ not json ", "utf8");

    await expect(loadGoldenSet(dir)).rejects.toThrowError(
      new RegExp(`${badPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: file is not valid JSON`),
    );
  });

  it("throws on a directory containing zero cases", async () => {
    const dir = await makeTempDir();

    await expect(loadGoldenSet(dir)).rejects.toThrowError(/golden set is empty/);
  });

  it("throws on duplicate transcript ids, naming both files", async () => {
    const dir = await makeTempDir();
    const firstPath = join(dir, "case_001.json");
    const secondPath = join(dir, "case_002.json");
    await writeFile(firstPath, JSON.stringify(validCaseObject("case_dupe")), "utf8");
    await writeFile(secondPath, JSON.stringify(validCaseObject("case_dupe")), "utf8");

    const error = await loadGoldenSet(dir).then(
      () => {
        throw new Error("expected loadGoldenSet to reject on duplicate ids");
      },
      (e: unknown) => e as Error,
    );

    expect(error.message).toContain("case_dupe");
    expect(error.message).toContain(firstPath);
    expect(error.message).toContain(secondPath);
  });

  it("ignores non-JSON files in the directory", async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, "case_001.json"),
      JSON.stringify(validCaseObject("case_001")),
      "utf8",
    );
    await writeFile(join(dir, "README.md"), "not a case", "utf8");

    const cases = await loadGoldenSet(dir);
    expect(cases).toHaveLength(1);
  });
});
