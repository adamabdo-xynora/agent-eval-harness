/**
 * Judge-vs-human agreement scoring, including Cohen's kappa.
 *
 * Module version: 1.0.0
 *
 * Raw percent agreement flatters a judge. With imbalanced golden sets — mostly passes,
 * a few fails — a judge that says "pass" to everything scores high agreement while
 * catching zero failures. Cohen's kappa corrects for chance agreement:
 *
 *     kappa = (po - pe) / (1 - pe)
 *
 * where po is observed agreement and pe is the agreement expected if both raters
 * labeled at their observed marginal rates independently. A judge that always says
 * "pass" has the same marginals as the constant rater it is being compared against, so
 * pe rises to meet po and kappa collapses toward zero — which is the whole point.
 *
 * This module implements kappa by hand rather than importing a stats library, and its
 * test suite includes a published worked example so the arithmetic is verified, not
 * trusted.
 */

import { CRITERIA } from "./golden.js";

/** One human label and one judge label for the same (transcript, criterion) cell. */
export interface LabelPair {
  humanVerdict: "pass" | "fail";
  judgeVerdict: "pass" | "fail";
  transcriptId: string;
  criterion: string;
}

/**
 * The 2x2 contingency table, human as the row rater and judge as the column rater.
 * Named rather than indexed: `humanPassJudgeFail` cannot be transposed by accident the
 * way `b` and `c` can.
 */
export interface ConfusionCounts {
  bothPass: number;
  bothFail: number;
  humanPassJudgeFail: number;
  humanFailJudgePass: number;
}

export interface AgreementReport {
  /** A criterion id, or "overall" for the pooled report. */
  criterion: string;
  n: number;
  /** po, in [0,1]. */
  observedAgreement: number;
  /**
   * null when pe === 1 — i.e. both raters were constant on the same label, so there is
   * no variation for chance correction to work on. Kappa is genuinely undefined there
   * (the formula is 0/0), and this module says so rather than emitting NaN, which would
   * poison downstream averages silently, or a fake 1.0, which would report a perfect
   * judge on the exact degenerate case — an all-pass golden set — where agreement
   * carries the least information.
   */
  kappa: number | null;
  confusion: ConfusionCounts;
  disagreements: Array<{
    transcriptId: string;
    criterion: string;
    humanVerdict: string;
    judgeVerdict: string;
  }>;
}

const CRITERION_IDS: readonly string[] = CRITERIA.map((c) => c.id);

/** The pooled report's criterion label. */
const OVERALL = "overall";

/**
 * Cohen's kappa from a 2x2 table. Pure arithmetic — no I/O, no rounding, no clamping.
 *
 * Returns the raw floating-point values. Callers that want 0.4 instead of
 * 0.3999999999999999 are asking a presentation question, and presentation belongs to
 * `formatAgreementTable`, not here: a "fixup" applied at the source would quietly
 * change the numbers a drift gate compares against.
 */
export function cohensKappa(counts: ConfusionCounts): {
  po: number;
  pe: number;
  kappa: number | null;
} {
  const { bothPass, bothFail, humanPassJudgeFail, humanFailJudgePass } = counts;

  for (const [field, value] of Object.entries(counts)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `cohensKappa: ${field} must be a non-negative finite number, got ${String(value)}`,
      );
    }
  }

  const n = bothPass + bothFail + humanPassJudgeFail + humanFailJudgePass;
  if (n === 0) {
    throw new Error(
      "cohensKappa: cannot score an empty table — all four counts are zero, so there " +
        "is nothing to agree or disagree about",
    );
  }

  // Observed agreement: the diagonal over the total.
  const po = (bothPass + bothFail) / n;

  // Marginals: how often each rater said "pass", independent of the other rater.
  const humanPassRate = (bothPass + humanPassJudgeFail) / n;
  const judgePassRate = (bothPass + humanFailJudgePass) / n;
  const humanFailRate = 1 - humanPassRate;
  const judgeFailRate = 1 - judgePassRate;

  // Expected agreement if the two raters were independent at those marginal rates.
  const pe = humanPassRate * judgePassRate + humanFailRate * judgeFailRate;

  // pe === 1 means both raters were constant on the same label: chance alone already
  // "explains" every agreement, and (po - pe) / (1 - pe) is 0/0. See AgreementReport.
  const kappa = pe === 1 ? null : (po - pe) / (1 - pe);

  return { po, pe, kappa };
}

function tallyConfusion(pairs: readonly LabelPair[]): ConfusionCounts {
  const counts: ConfusionCounts = {
    bothPass: 0,
    bothFail: 0,
    humanPassJudgeFail: 0,
    humanFailJudgePass: 0,
  };

  for (const pair of pairs) {
    if (pair.humanVerdict === "pass") {
      if (pair.judgeVerdict === "pass") counts.bothPass += 1;
      else counts.humanPassJudgeFail += 1;
    } else {
      if (pair.judgeVerdict === "pass") counts.humanFailJudgePass += 1;
      else counts.bothFail += 1;
    }
  }

  return counts;
}

function buildReport(criterion: string, pairs: readonly LabelPair[]): AgreementReport {
  const confusion = tallyConfusion(pairs);
  const { po, kappa } = cohensKappa(confusion);

  const disagreements = pairs
    .filter((pair) => pair.humanVerdict !== pair.judgeVerdict)
    .map((pair) => ({
      transcriptId: pair.transcriptId,
      criterion: pair.criterion,
      humanVerdict: pair.humanVerdict,
      judgeVerdict: pair.judgeVerdict,
    }));

  return {
    criterion,
    n: pairs.length,
    observedAgreement: po,
    kappa,
    confusion,
    disagreements,
  };
}

/**
 * One report per criterion present in `pairs`, plus a final pooled "overall" report.
 *
 * Per-criterion first because that is where a judge actually drifts: a judge can hold
 * substantial agreement overall while being useless on `safety` alone, and the pooled
 * number hides exactly that. The pooled report comes last, as a summary of rows the
 * reader has already seen.
 *
 * Ordering is CRITERIA order for known criteria, then any unknown ones alphabetically,
 * so a report table is stable across runs and diffable in CI.
 */
export function scoreAgreement(pairs: LabelPair[]): AgreementReport[] {
  if (pairs.length === 0) {
    throw new Error(
      "scoreAgreement: no label pairs — an agreement score over zero comparisons is " +
        "not a weak signal, it is no signal",
    );
  }

  // Insertion-ordered buckets; the sort below imposes the reporting order.
  const byCriterion = new Map<string, LabelPair[]>();
  for (const pair of pairs) {
    const bucket = byCriterion.get(pair.criterion);
    if (bucket === undefined) byCriterion.set(pair.criterion, [pair]);
    else bucket.push(pair);
  }

  const known: string[] = [];
  const unknown: string[] = [];
  for (const criterion of byCriterion.keys()) {
    if (CRITERION_IDS.includes(criterion)) known.push(criterion);
    else unknown.push(criterion);
  }
  known.sort((a, b) => CRITERION_IDS.indexOf(a) - CRITERION_IDS.indexOf(b));
  unknown.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const reports: AgreementReport[] = [];
  for (const criterion of [...known, ...unknown]) {
    reports.push(buildReport(criterion, byCriterion.get(criterion) ?? []));
  }

  // Pooled across every pair. Note this is a single 2x2 table over all criteria, not an
  // average of the per-criterion kappas — the marginals are recomputed from the pool.
  reports.push(buildReport(OVERALL, pairs));

  return reports;
}

const HEADERS = ["criterion", "n", "agreement", "kappa", "disagreements"] as const;

/** The reading aid printed under every table, so a bare kappa is never uninterpreted. */
const KAPPA_LEGEND =
  "kappa: <0 worse than chance, 0 chance, 0.4-0.6 moderate, 0.6-0.8 substantial, >0.8 near-perfect";

/**
 * Plain-text report table. Rounding happens here and only here — see `cohensKappa`.
 * Hand-rolled rather than pulled from a table library: the harness's dependency list is
 * part of its trustworthiness, and this is twenty lines of padding.
 */
export function formatAgreementTable(reports: AgreementReport[]): string {
  const rows = reports.map((report) => [
    report.criterion,
    String(report.n),
    `${(report.observedAgreement * 100).toFixed(1)}%`,
    report.kappa === null ? "undefined" : report.kappa.toFixed(3),
    String(report.disagreements.length),
  ]);

  const widths = HEADERS.map((header, column) =>
    rows.reduce((width, row) => Math.max(width, (row[column] ?? "").length), header.length),
  );

  // The criterion column reads as a label, so it is left-aligned; every other column is
  // a number, and numbers line up on the right.
  const renderCell = (text: string, column: number): string => {
    const width = widths[column] ?? text.length;
    return column === 0 ? text.padEnd(width) : text.padStart(width);
  };

  const renderRow = (cells: readonly string[]): string =>
    cells.map((cell, column) => renderCell(cell, column)).join(" | ");

  const lines = [
    renderRow(HEADERS),
    widths.map((width) => "-".repeat(width)).join("-+-"),
    ...rows.map((row) => renderRow(row)),
    KAPPA_LEGEND,
  ];

  return lines.join("\n");
}
