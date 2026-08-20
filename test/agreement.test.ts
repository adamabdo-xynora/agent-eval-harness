import { describe, expect, it } from "vitest";

import {
  cohensKappa,
  formatAgreementTable,
  scoreAgreement,
  type ConfusionCounts,
  type LabelPair,
} from "../src/agreement.js";

/**
 * The point of these tests is that the kappa arithmetic is *verified*, not trusted.
 * The anchor is a published worked example with numbers someone else computed; the rest
 * pin the degenerate cases where a hand-rolled implementation is most likely to fake an
 * answer (all-pass tables, chance-level agreement, worse-than-chance agreement).
 */

/** Convenience: a full 2x2 table from the textbook's (a, b, c, d) ordering. */
function counts(
  bothPass: number,
  humanPassJudgeFail: number,
  humanFailJudgePass: number,
  bothFail: number,
): ConfusionCounts {
  return { bothPass, humanPassJudgeFail, humanFailJudgePass, bothFail };
}

describe("cohensKappa", () => {
  it("reproduces the published worked example", () => {
    // Source: Wikipedia, "Cohen's kappa", the worked 2x2 example — two raters, 50
    // items, rater A says yes 25 times and no 25 times. Agreement table:
    //   a = 20 (both yes), b = 5 (A yes, B no), c = 10 (A no, B yes), d = 15 (both no)
    // giving po = 0.70, pe = 0.50, kappa = 0.40 exactly.
    // Mapping for this module: rater A -> human, rater B -> judge, yes -> pass.
    const { po, pe, kappa } = cohensKappa(counts(20, 5, 10, 15));

    expect(po).toBeCloseTo(0.7, 12);
    expect(pe).toBeCloseTo(0.5, 12);
    expect(kappa).not.toBeNull();
    expect(kappa as number).toBeCloseTo(0.4, 12);
  });

  it("returns kappa 1 for perfect agreement", () => {
    // Both raters vary, and they never differ.
    const { po, pe, kappa } = cohensKappa(counts(12, 0, 0, 8));

    expect(po).toBe(1);
    expect(pe).toBeCloseTo(0.52, 12); // 0.6*0.6 + 0.4*0.4
    expect(kappa).toBe(1);
  });

  it("returns kappa 0 when agreement is no better than chance", () => {
    // a = b = c = d = 1: po = 0.5 and pe = 0.5, so the judge added nothing over a coin.
    const { po, pe, kappa } = cohensKappa(counts(1, 1, 1, 1));

    expect(po).toBe(0.5);
    expect(pe).toBe(0.5);
    expect(kappa).toBe(0);
  });

  it("returns kappa null for the all-pass degenerate case", () => {
    // The case this module exists to be honest about: both raters said "pass" to
    // everything. Observed agreement is a perfect 100%, chance agreement is also 100%,
    // and kappa is 0/0 — undefined, not 1.0, and not NaN.
    const { po, pe, kappa } = cohensKappa(counts(10, 0, 0, 0));

    expect(po).toBe(1);
    expect(pe).toBe(1);
    expect(kappa).toBeNull();
  });

  it("returns a negative kappa when agreement is worse than chance", () => {
    // The raters are perfectly anti-correlated: every item is a disagreement.
    const { po, pe, kappa } = cohensKappa(counts(0, 5, 5, 0));

    expect(po).toBe(0);
    expect(pe).toBe(0.5);
    expect(kappa).toBe(-1);
    expect(kappa as number).toBeLessThan(0);
  });

  it("throws on an all-zero table", () => {
    expect(() => cohensKappa(counts(0, 0, 0, 0))).toThrow(/empty table/);
  });

  it("is a deterministic, well-bounded function of arbitrary counts", () => {
    // Property-style spot check with a seeded PRNG (mulberry32), so the 20 cases are
    // identical on every machine and every run — a flaky property test in a harness
    // that gates CI is worse than no property test.
    let state = 0x9e3779b9;
    const random = (): number => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const draw = (): number => Math.floor(random() * 13);

    for (let i = 0; i < 20; i += 1) {
      const table = counts(draw(), draw(), draw(), draw());
      const n =
        table.bothPass +
        table.bothFail +
        table.humanPassJudgeFail +
        table.humanFailJudgePass;
      if (n === 0) {
        expect(() => cohensKappa(table)).toThrow();
        continue;
      }

      const { po, pe, kappa } = cohensKappa(table);

      expect(po).toBeGreaterThanOrEqual(0);
      expect(po).toBeLessThanOrEqual(1);
      expect(pe).toBeGreaterThanOrEqual(0);
      expect(pe).toBeLessThanOrEqual(1);

      if (kappa !== null) {
        expect(Number.isNaN(kappa)).toBe(false);
        expect(kappa).toBeLessThanOrEqual(1);
      }
    }
  });
});

/**
 * Two criteria with hand-computable tables:
 *
 *   task_completion (n = 6): a=2, b=1, c=1, d=2
 *     po = 4/6 = 2/3; marginals 0.5 / 0.5; pe = 0.5; kappa = (2/3 - 1/2) / (1/2) = 1/3
 *
 *   grounding (n = 4): a=3, b=0, c=1, d=0  — the judge passed everything
 *     po = 3/4; marginals human 0.75 / judge 1.0; pe = 0.75; kappa = 0
 *     (75% agreement, zero skill: exactly the illusion kappa exists to strip)
 *
 *   overall (n = 10, pooled): a=5, b=1, c=2, d=2
 *     po = 7/10 = 0.7; marginals human 0.6 / judge 0.7; pe = 0.42 + 0.12 = 0.54
 *     kappa = 0.16 / 0.46 = 8/23
 *
 * The pairs are interleaved so input order differs from per-criterion order, which is
 * what makes the disagreement-ordering assertions meaningful.
 */
const PAIRS: LabelPair[] = [
  pair("case_01", "task_completion", "pass", "pass"),
  pair("case_01", "grounding", "pass", "pass"),
  pair("case_03", "task_completion", "pass", "fail"), // disagreement 1
  pair("case_04", "grounding", "fail", "pass"), // disagreement 2
  pair("case_02", "task_completion", "pass", "pass"),
  pair("case_02", "grounding", "pass", "pass"),
  pair("case_04", "task_completion", "fail", "fail"),
  pair("case_03", "grounding", "pass", "pass"),
  pair("case_05", "task_completion", "fail", "fail"),
  pair("case_06", "task_completion", "fail", "pass"), // disagreement 3
];

function pair(
  transcriptId: string,
  criterion: string,
  humanVerdict: "pass" | "fail",
  judgeVerdict: "pass" | "fail",
): LabelPair {
  return { transcriptId, criterion, humanVerdict, judgeVerdict };
}

describe("scoreAgreement", () => {
  it("reports each criterion in CRITERIA order, then the pooled overall", () => {
    const reports = scoreAgreement(PAIRS);

    expect(reports.map((r) => r.criterion)).toEqual([
      "task_completion",
      "grounding",
      "overall",
    ]);
  });

  it("sorts unknown criteria alphabetically after the known ones", () => {
    const reports = scoreAgreement([
      pair("case_01", "zeta_custom", "pass", "pass"),
      pair("case_01", "grounding", "pass", "pass"),
      pair("case_01", "alpha_custom", "pass", "fail"),
      pair("case_01", "task_completion", "pass", "pass"),
    ]);

    expect(reports.map((r) => r.criterion)).toEqual([
      "task_completion",
      "grounding",
      "alpha_custom",
      "zeta_custom",
      "overall",
    ]);
  });

  it("matches hand-computed po and kappa for task_completion", () => {
    const report = scoreAgreement(PAIRS)[0]!;

    expect(report.criterion).toBe("task_completion");
    expect(report.n).toBe(6);
    expect(report.confusion).toEqual({
      bothPass: 2,
      humanPassJudgeFail: 1,
      humanFailJudgePass: 1,
      bothFail: 2,
    });
    expect(report.observedAgreement).toBeCloseTo(2 / 3, 12);
    expect(report.kappa).not.toBeNull();
    expect(report.kappa as number).toBeCloseTo(1 / 3, 12);
  });

  it("matches hand-computed po and kappa for grounding, where the judge passed everything", () => {
    const report = scoreAgreement(PAIRS)[1]!;

    expect(report.criterion).toBe("grounding");
    expect(report.n).toBe(4);
    expect(report.confusion).toEqual({
      bothPass: 3,
      humanPassJudgeFail: 0,
      humanFailJudgePass: 1,
      bothFail: 0,
    });
    expect(report.observedAgreement).toBeCloseTo(0.75, 12);
    // 75% agreement, kappa 0 — the judge is no better than chance on this criterion.
    expect(report.kappa).not.toBeNull();
    expect(report.kappa as number).toBeCloseTo(0, 12);
  });

  it("pools every pair into the overall report", () => {
    const reports = scoreAgreement(PAIRS);
    const overall = reports[reports.length - 1]!;

    expect(overall.criterion).toBe("overall");
    expect(overall.n).toBe(10);
    expect(overall.confusion).toEqual({
      bothPass: 5,
      humanPassJudgeFail: 1,
      humanFailJudgePass: 2,
      bothFail: 2,
    });
    expect(overall.observedAgreement).toBeCloseTo(0.7, 12);
    expect(overall.kappa).not.toBeNull();
    expect(overall.kappa as number).toBeCloseTo(8 / 23, 12);
  });

  it("lists disagreements in input order, per criterion and pooled", () => {
    const [taskCompletion, grounding, overall] = scoreAgreement(PAIRS);

    expect(taskCompletion!.disagreements).toEqual([
      {
        transcriptId: "case_03",
        criterion: "task_completion",
        humanVerdict: "pass",
        judgeVerdict: "fail",
      },
      {
        transcriptId: "case_06",
        criterion: "task_completion",
        humanVerdict: "fail",
        judgeVerdict: "pass",
      },
    ]);

    expect(grounding!.disagreements.map((d) => d.transcriptId)).toEqual(["case_04"]);

    // Input order across criteria, not the per-criterion lists concatenated.
    expect(overall!.disagreements.map((d) => d.transcriptId)).toEqual([
      "case_03",
      "case_04",
      "case_06",
    ]);
    expect(overall!.disagreements.map((d) => d.criterion)).toEqual([
      "task_completion",
      "grounding",
      "task_completion",
    ]);
  });

  it("throws on empty input", () => {
    expect(() => scoreAgreement([])).toThrow(/no label pairs/);
  });
});

describe("formatAgreementTable", () => {
  it("renders one row per report plus a header, rule, and reading aid", () => {
    const reports = scoreAgreement(PAIRS);
    const lines = formatAgreementTable(reports).split("\n");

    // header + rule + 3 reports + legend
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain("criterion");
    expect(lines[0]).toContain("agreement");
    expect(lines[0]).toContain("kappa");
    expect(lines[0]).toContain("disagreements");

    expect(lines[2]).toContain("task_completion");
    expect(lines[2]).toContain("66.7%"); // po = 2/3, one decimal
    expect(lines[2]).toContain("0.333");
    expect(lines[4]).toContain("overall");
    expect(lines[4]).toContain("70.0%");
  });

  it("prints \"undefined\" rather than a number for a null kappa", () => {
    const allPass: LabelPair[] = [
      pair("case_01", "safety", "pass", "pass"),
      pair("case_02", "safety", "pass", "pass"),
    ];
    const table = formatAgreementTable(scoreAgreement(allPass));

    expect(table).toContain("undefined");
    expect(table).toContain("100.0%");
    expect(table).not.toMatch(/\b1\.000\b/);
  });

  it("ends with the kappa reading aid", () => {
    const lines = formatAgreementTable(scoreAgreement(PAIRS)).split("\n");

    expect(lines[lines.length - 1]).toBe(
      "kappa: <0 worse than chance, 0 chance, 0.4-0.6 moderate, 0.6-0.8 substantial, >0.8 near-perfect",
    );
  });

  it("aligns columns: every separator sits at the same index in header and data rows", () => {
    const lines = formatAgreementTable(scoreAgreement(PAIRS)).split("\n");
    const header = lines[0]!;
    const dataRow = lines[2]!; // task_completion — the longest criterion name

    const separatorIndexes = (line: string): number[] => {
      const indexes: number[] = [];
      for (let i = line.indexOf("|"); i !== -1; i = line.indexOf("|", i + 1)) {
        indexes.push(i);
      }
      return indexes;
    };

    expect(separatorIndexes(header)).toHaveLength(4);
    expect(separatorIndexes(dataRow)).toEqual(separatorIndexes(header));
    // And the same holds for every data row, not just the widest one.
    for (const line of lines.slice(2, -1)) {
      expect(separatorIndexes(line)).toEqual(separatorIndexes(header));
    }
  });
});
