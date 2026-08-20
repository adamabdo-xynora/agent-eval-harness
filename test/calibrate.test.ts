import { describe, expect, it } from "vitest";

import { CRITERIA, type GoldenCase } from "../src/golden.js";
import type { ModelClient } from "../src/judge.js";
import { scoreAgreement, type LabelPair } from "../src/agreement.js";
import {
  applyGate,
  DEFAULT_GATE_POLICY,
  formatGateReport,
  runCalibration,
  type CalibrationResult,
  type GatePolicy,
} from "../src/calibrate.js";

/**
 * No test in this file may touch the network: every model interaction goes through a
 * fake `ModelClient` scripted by transcript id.
 *
 * The gate tests build their `CalibrationResult`s by running real pairs through the real
 * `scoreAgreement`, rather than hand-writing `AgreementReport` objects. Hand-written
 * reports would let a test assert a kappa the scoring module would never produce, and
 * the gate's whole job is to react correctly to numbers that module actually emits.
 */

const CRITERION_IDS: readonly string[] = CRITERIA.map((c) => c.id);

type Verdict = "pass" | "fail";

/** `"PF"` = human said pass, judge said fail. One token per (transcript, criterion) cell. */
function cells(criterion: string, spec: string): LabelPair[] {
  return spec.split(" ").map((token, index): LabelPair => {
    if (!/^[PF]{2}$/.test(token)) {
      throw new Error(`cells: bad token "${token}" — expected two of P/F, e.g. "PF"`);
    }
    return {
      criterion,
      transcriptId: `${criterion}_case_${index}`,
      humanVerdict: token[0] === "P" ? "pass" : "fail",
      judgeVerdict: token[1] === "P" ? "pass" : "fail",
    };
  });
}

/** A calibration result as `runCalibration` would have produced it from these pairs. */
function resultFrom(
  pairs: LabelPair[],
  judgeFailures: Array<{ transcriptId: string; error: string }> = [],
): CalibrationResult {
  return {
    pairs,
    reports: pairs.length > 0 ? scoreAgreement(pairs) : [],
    judgeFailures,
    // The gate never reads raw responses; these fixtures carry none.
    judgeRawResponses: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:12.000Z",
  };
}

/** A golden case whose human labels cover every criterion, in CRITERIA order. */
function goldenCase(id: string, humanVerdicts: Verdict[]): GoldenCase {
  return {
    transcript: {
      id,
      description: `fixture transcript ${id}`,
      messages: [
        { role: "user", content: "Reschedule my Roadmap Sync in Driftless." },
        { role: "assistant", content: "Done — it is now Friday at 10:00 AM." },
      ],
    },
    labels: CRITERION_IDS.map((criterion, index) => ({
      criterion,
      verdict: humanVerdicts[index] ?? "pass",
      rationale: `human rationale for ${criterion} on ${id}`,
    })),
  };
}

/**
 * The exact reply body `scriptedClient` returns for a set of verdicts. Shared with the
 * tests so `judgeRawResponses` can be asserted against the same string the fake emitted,
 * rather than against a re-spelling of it that could drift.
 */
function scriptedReply(verdicts: Verdict[]): string {
  return JSON.stringify({
    verdicts: CRITERION_IDS.map((criterion, index) => ({
      criterion,
      verdict: verdicts[index] ?? "pass",
      rationale: `judge rationale for ${criterion}`,
    })),
  });
}

/**
 * A `ModelClient` scripted by transcript id: either the judge verdicts to return (in
 * CRITERIA order) or an Error to throw, standing in for a transport failure. An
 * unscripted transcript throws loudly rather than returning something plausible.
 */
function scriptedClient(script: Record<string, Verdict[] | Error>): ModelClient & {
  judged: string[];
} {
  const judged: string[] = [];
  return {
    judged,
    async complete({ user }) {
      const found = /^Transcript \(id: (.+)\):$/m.exec(user);
      const id = found?.[1];
      if (id === undefined) throw new Error("fake client: no transcript id in prompt");

      judged.push(id);
      const entry = script[id];
      if (entry === undefined) throw new Error(`fake client: unscripted transcript ${id}`);
      if (entry instanceof Error) throw entry;

      return scriptedReply(entry);
    },
  };
}

/** Compact, order-sensitive rendering of the pairs a run produced. */
function renderPairs(pairs: LabelPair[]): string[] {
  return pairs.map(
    (pair) =>
      `${pair.transcriptId}:${pair.criterion}:${pair.humanVerdict}->${pair.judgeVerdict}`,
  );
}

describe("runCalibration", () => {
  it("pairs every judge verdict with the human label for the same criterion", async () => {
    const cases = [
      goldenCase("case_a", ["pass", "pass", "fail"]),
      goldenCase("case_b", ["fail", "pass", "pass"]),
      goldenCase("case_c", ["pass", "fail", "pass"]),
    ];
    const client = scriptedClient({
      case_a: ["pass", "pass", "fail"],
      // The judge disagrees with the human on safety here, and only here.
      case_b: ["fail", "pass", "fail"],
      case_c: ["pass", "fail", "pass"],
    });

    const result = await runCalibration(client, cases);

    expect(result.judgeFailures).toEqual([]);
    expect(result.pairs).toHaveLength(cases.length * CRITERION_IDS.length);
    expect(renderPairs(result.pairs)).toEqual([
      "case_a:task_completion:pass->pass",
      "case_a:grounding:pass->pass",
      "case_a:safety:fail->fail",
      "case_b:task_completion:fail->fail",
      "case_b:grounding:pass->pass",
      "case_b:safety:pass->fail",
      "case_c:task_completion:pass->pass",
      "case_c:grounding:fail->fail",
      "case_c:safety:pass->pass",
    ]);

    // Every pair carries the judge's own reasoning for the verdict it holds. This is
    // what makes a disagreement row in the artifact worth reading: the verdict says the
    // judge was wrong, the rationale says why it thought otherwise.
    expect(result.pairs.map((pair) => pair.judgeRationale)).toEqual([
      "judge rationale for task_completion",
      "judge rationale for grounding",
      "judge rationale for safety",
      "judge rationale for task_completion",
      "judge rationale for grounding",
      "judge rationale for safety",
      "judge rationale for task_completion",
      "judge rationale for grounding",
      "judge rationale for safety",
    ]);

    // One verbatim reply per successfully judged transcript, in judging order.
    expect(result.judgeRawResponses).toEqual([
      { transcriptId: "case_a", rawResponse: scriptedReply(["pass", "pass", "fail"]) },
      { transcriptId: "case_b", rawResponse: scriptedReply(["fail", "pass", "fail"]) },
      { transcriptId: "case_c", rawResponse: scriptedReply(["pass", "fail", "pass"]) },
    ]);

    // Cases were judged sequentially, in golden-set order.
    expect(client.judged).toEqual(["case_a", "case_b", "case_c"]);

    // One report per criterion, plus the pooled row.
    expect(result.reports.map((report) => report.criterion)).toEqual([
      ...CRITERION_IDS,
      "overall",
    ]);

    expect(result.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(result.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(Date.parse(result.finishedAt)).toBeGreaterThanOrEqual(
      Date.parse(result.startedAt),
    );
  });

  it("records a judge error and keeps calibrating the remaining cases", async () => {
    const cases = [
      goldenCase("case_a", ["pass", "pass", "fail"]),
      goldenCase("case_b", ["fail", "pass", "pass"]),
      goldenCase("case_c", ["pass", "fail", "pass"]),
    ];
    const client = scriptedClient({
      case_a: ["pass", "pass", "fail"],
      case_b: new Error("529 overloaded"),
      case_c: ["pass", "fail", "pass"],
    });

    const result = await runCalibration(client, cases);

    expect(result.judgeFailures).toHaveLength(1);
    expect(result.judgeFailures[0]?.transcriptId).toBe("case_b");
    expect(result.judgeFailures[0]?.error).toContain("529 overloaded");

    // The flaky call cost its own transcript's pairs and nothing else.
    expect(result.pairs).toHaveLength(2 * CRITERION_IDS.length);
    expect(result.pairs.some((pair) => pair.transcriptId === "case_b")).toBe(false);
    expect(renderPairs(result.pairs)).toEqual([
      "case_a:task_completion:pass->pass",
      "case_a:grounding:pass->pass",
      "case_a:safety:fail->fail",
      "case_c:task_completion:pass->pass",
      "case_c:grounding:fail->fail",
      "case_c:safety:pass->pass",
    ]);

    // A transcript that failed emitted no reply to record. Raw responses and judge
    // failures partition the golden set; nothing appears in both.
    expect(result.judgeRawResponses).toEqual([
      { transcriptId: "case_a", rawResponse: scriptedReply(["pass", "pass", "fail"]) },
      { transcriptId: "case_c", rawResponse: scriptedReply(["pass", "fail", "pass"]) },
    ]);
    expect(
      result.judgeRawResponses.some((entry) => entry.transcriptId === "case_b"),
    ).toBe(false);

    // The judge was still asked about case_c after case_b blew up.
    expect(client.judged).toEqual(["case_a", "case_b", "case_c"]);
  });

  it("returns an empty-but-reportable result when every case fails", async () => {
    const cases = [goldenCase("case_a", ["pass", "pass", "pass"])];
    const client = scriptedClient({ case_a: new Error("connection reset") });

    const result = await runCalibration(client, cases);

    // No throw: scoring an empty set is skipped, and the gate turns it into violations.
    expect(result.pairs).toEqual([]);
    expect(result.reports).toEqual([]);
    expect(result.judgeRawResponses).toEqual([]);
    expect(result.judgeFailures).toHaveLength(1);
    expect(applyGate(result).pass).toBe(false);
  });
});

describe("runCalibration progress", () => {
  /**
   * Long enough that the wrapped message exceeds the 80-character budget, so the
   * truncation is exercised rather than merely permitted.
   */
  const TRANSPORT_ERROR = "529 overloaded: upstream capacity exceeded, retry after backoff";

  it("announces each case before judging it and reports the outcome after", async () => {
    const cases = [
      goldenCase("case_a", ["pass", "pass", "fail"]),
      goldenCase("case_b", ["fail", "pass", "pass"]),
    ];
    const client = scriptedClient({
      case_a: ["pass", "pass", "fail"],
      case_b: new Error(TRANSPORT_ERROR),
    });

    const messages: string[] = [];
    const result = await runCalibration(client, cases, (message) => messages.push(message));

    // Exact sequence: the "judging" line lands BEFORE the model call, which is the whole
    // point — a run that hangs on case_b has already told the operator where it is.
    expect(messages).toEqual([
      "judging case_a (1/2)...",
      "  case_a: ok",
      "judging case_b (2/2)...",
      // The recorded error, cut to 80 characters — a progress line stays one line.
      '  case_b: FAILED — judging transcript "case_b" failed: model client error: 529 overloaded: upstream',
    ]);

    // Progress is commentary, not measurement: the result is what it would have been.
    expect(result.pairs).toHaveLength(CRITERION_IDS.length);
    expect(result.judgeFailures.map((failure) => failure.transcriptId)).toEqual(["case_b"]);
  });

  it("truncates the failure line to 80 characters of the recorded error", async () => {
    const cases = [goldenCase("case_b", ["pass", "pass", "pass"])];
    const client = scriptedClient({ case_b: new Error(TRANSPORT_ERROR) });

    const messages: string[] = [];
    const result = await runCalibration(client, cases, (message) => messages.push(message));

    const recorded = result.judgeFailures[0]?.error ?? "";
    expect(recorded.length).toBeGreaterThan(80);

    const failureLine = messages[1] ?? "";
    expect(failureLine).toBe(`  case_b: FAILED — ${recorded.slice(0, 80)}`);

    // The full error survives in the result even though the progress line is clipped.
    expect(recorded).toContain(TRANSPORT_ERROR);
  });

  it("runs unchanged when no onProgress is given", async () => {
    const cases = [goldenCase("case_a", ["pass", "pass", "fail"])];
    const script = { case_a: ["pass", "pass", "fail"] as Verdict[] };

    const withoutProgress = await runCalibration(scriptedClient(script), cases);
    const withProgress = await runCalibration(scriptedClient(script), cases, () => {});

    expect(withoutProgress.pairs).toEqual(withProgress.pairs);
    expect(withoutProgress.judgeFailures).toEqual([]);
    expect(withoutProgress.judgeRawResponses).toEqual(withProgress.judgeRawResponses);
    expect(renderPairs(withoutProgress.pairs)).toEqual([
      "case_a:task_completion:pass->pass",
      "case_a:grounding:pass->pass",
      "case_a:safety:fail->fail",
    ]);
  });
});

describe("applyGate", () => {
  it("passes a calibration with substantial per-criterion agreement", () => {
    const pairs = [
      ...cells("task_completion", "PP PP FF FF"),
      ...cells("grounding", "PP PP FF FF"),
      ...cells("safety", "PP PP FF FF"),
    ];

    const verdict = applyGate(resultFrom(pairs), DEFAULT_GATE_POLICY);

    expect(verdict.violations).toEqual([]);
    expect(verdict.pass).toBe(true);
  });

  it("a unanimous judge does not pass the gate on kappa it never earned", () => {
    // `safety` is all-pass on BOTH sides: 100% observed agreement, kappa undefined.
    // This is the shape a judge that has stopped discriminating produces, and it is the
    // single most important thing this gate must refuse.
    const pairs = [
      ...cells("task_completion", "PP PP FF FF"),
      ...cells("grounding", "PP PP FF FF"),
      ...cells("safety", "PP PP PP PP"),
    ];
    const result = resultFrom(pairs);

    const safety = result.reports.find((report) => report.criterion === "safety");
    expect(safety?.observedAgreement).toBe(1); // it looks perfect...
    expect(safety?.kappa).toBeNull(); // ...and demonstrates nothing.

    const verdict = applyGate(result, DEFAULT_GATE_POLICY);

    expect(verdict.pass).toBe(false);
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0]).toContain("safety");
    expect(verdict.violations[0]).toContain("insufficient signal");
  });

  it("fails the weak criterion even when the pooled kappa looks healthy", () => {
    // task_completion and grounding are scored perfectly; safety is a lenient judge that
    // says "pass" to everything a human passed AND to the one case a human failed.
    // Its observed agreement (87.5%) clears the bar; its kappa is exactly zero.
    const pairs = [
      ...cells("task_completion", "PP PP PP PP FF FF FF FF"),
      ...cells("grounding", "PP PP PP PP FF FF FF FF"),
      ...cells("safety", "PP PP PP PP PP PP PP FP"),
    ];
    const result = resultFrom(pairs);

    const safety = result.reports.find((report) => report.criterion === "safety");
    const overall = result.reports.find((report) => report.criterion === "overall");

    // The construction, made explicit: pooling hides the collapse.
    expect(safety?.kappa).toBe(0);
    expect(safety?.observedAgreement).toBeGreaterThan(
      DEFAULT_GATE_POLICY.minObservedAgreement,
    );
    expect(overall?.kappa).not.toBeNull();
    expect(overall?.kappa as number).toBeGreaterThan(
      DEFAULT_GATE_POLICY.minKappaPerCriterion,
    );

    const verdict = applyGate(result, DEFAULT_GATE_POLICY);

    expect(verdict.pass).toBe(false);
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0]).toMatch(/^safety: kappa 0\.000 is below the required 0\.600/);
    expect(verdict.violations.join("\n")).not.toContain("task_completion");
    expect(verdict.violations.join("\n")).not.toContain("grounding");
  });

  it("fails a criterion with too few pairs to measure", () => {
    const pairs = [
      ...cells("task_completion", "PP FF"),
      ...cells("grounding", "PP PP FF FF"),
      ...cells("safety", "PP PP FF FF"),
    ];
    const result = resultFrom(pairs);

    // Perfect agreement on those two pairs — the gate refuses anyway.
    expect(result.reports.find((r) => r.criterion === "task_completion")?.kappa).toBe(1);

    const verdict = applyGate(result, DEFAULT_GATE_POLICY);

    expect(verdict.pass).toBe(false);
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0]).toContain("task_completion");
    expect(verdict.violations[0]).toContain("2 label pair(s)");
    expect(verdict.violations[0]).toContain("at least 4");
  });

  it("fails on low observed agreement, naming the actual and required numbers", () => {
    const policy: GatePolicy = { ...DEFAULT_GATE_POLICY, minKappaPerCriterion: -1 };
    const pairs = [
      ...cells("task_completion", "PP PP FF FF"),
      ...cells("grounding", "PP PP FF FF"),
      // Half right: po = 0.500.
      ...cells("safety", "PP PF FP FF"),
    ];

    const verdict = applyGate(resultFrom(pairs), policy);

    expect(verdict.pass).toBe(false);
    expect(verdict.violations).toEqual([
      expect.stringContaining("safety: observed agreement 0.500 is below the required 0.750"),
    ]);
  });

  it("fails listing the transcript ids the judge errored on", () => {
    const pairs = [
      ...cells("task_completion", "PP PP FF FF"),
      ...cells("grounding", "PP PP FF FF"),
      ...cells("safety", "PP PP FF FF"),
    ];
    const result = resultFrom(pairs, [
      { transcriptId: "case_injection_refusal", error: "529 overloaded" },
      { transcriptId: "case_stale_doc", error: "socket hang up" },
    ]);

    const verdict = applyGate(result, DEFAULT_GATE_POLICY);

    expect(verdict.pass).toBe(false);
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0]).toContain("case_injection_refusal");
    expect(verdict.violations[0]).toContain("case_stale_doc");
    expect(verdict.violations[0]).toContain("allowed at most 0");
  });

  it("tolerates judge failures up to the allowance", () => {
    const pairs = [
      ...cells("task_completion", "PP PP FF FF"),
      ...cells("grounding", "PP PP FF FF"),
      ...cells("safety", "PP PP FF FF"),
    ];
    const result = resultFrom(pairs, [{ transcriptId: "case_flaky", error: "timeout" }]);

    const verdict = applyGate(result, { ...DEFAULT_GATE_POLICY, maxJudgeFailures: 1 });

    expect(verdict).toEqual({ pass: true, violations: [] });
  });

  it("reports every simultaneous violation, not just the first", () => {
    const pairs = [
      ...cells("task_completion", "PP PP FF FF"), // fine
      ...cells("grounding", "PP FF"), // too few pairs
      ...cells("safety", "PP PP PP PP PP PP"), // all-pass: kappa undefined
    ];
    const result = resultFrom(pairs, [{ transcriptId: "case_flaky", error: "timeout" }]);

    const verdict = applyGate(result, DEFAULT_GATE_POLICY);

    expect(verdict.pass).toBe(false);
    expect(verdict.violations).toHaveLength(3);

    const joined = verdict.violations.join("\n");
    expect(joined).toContain("case_flaky");
    expect(joined).toContain("grounding: 2 label pair(s)");
    expect(joined).toContain("safety: kappa is undefined (insufficient signal)");
  });

  it("defaults to DEFAULT_GATE_POLICY when no policy is given", () => {
    const pairs = [
      ...cells("task_completion", "PP PP FF FF"),
      ...cells("grounding", "PP PP FF FF"),
      ...cells("safety", "PP PP PP PP"),
    ];

    expect(applyGate(resultFrom(pairs))).toEqual(
      applyGate(resultFrom(pairs), DEFAULT_GATE_POLICY),
    );
  });
});

describe("DEFAULT_GATE_POLICY", () => {
  it("has the documented thresholds", () => {
    // Pinned deliberately: a refactor that quietly loosens a threshold turns a green
    // build from evidence into decoration, and nothing else in the suite would notice.
    expect(DEFAULT_GATE_POLICY).toEqual({
      minKappaPerCriterion: 0.6,
      minObservedAgreement: 0.75,
      maxJudgeFailures: 0,
      minPairsPerCriterion: 4,
    });
  });
});

describe("formatGateReport", () => {
  it("prints the agreement table, then the FAIL line, then one line per violation", () => {
    const pairs = [
      ...cells("task_completion", "PP PP FF FF"),
      ...cells("grounding", "PP FF"),
      ...cells("safety", "PP PP PP PP PP PP"),
    ];
    const result = resultFrom(pairs, [{ transcriptId: "case_flaky", error: "timeout" }]);
    const verdict = applyGate(result, DEFAULT_GATE_POLICY);

    const report = formatGateReport(result, verdict);

    // The table, verbatim, followed by exactly one blank line.
    expect(report).toContain("criterion");
    expect(report).toContain("kappa");
    expect(report).toContain("overall");
    expect(report).toContain("\n\nGATE: FAIL");
    expect(report).not.toContain("GATE: PASS");

    for (const violation of verdict.violations) {
      expect(report).toContain(`\n  - ${violation}`);
    }

    // Nothing after the violations.
    const lines = report.split("\n");
    expect(lines.slice(-verdict.violations.length)).toEqual(
      verdict.violations.map((violation) => `  - ${violation}`),
    );
  });

  it("prints a bare PASS line when there are no violations", () => {
    const pairs = [
      ...cells("task_completion", "PP PP FF FF"),
      ...cells("grounding", "PP PP FF FF"),
      ...cells("safety", "PP PP FF FF"),
    ];
    const result = resultFrom(pairs);

    const report = formatGateReport(result, applyGate(result));

    expect(report.endsWith("\n\nGATE: PASS")).toBe(true);
  });
});
