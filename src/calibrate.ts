/**
 * Calibration runner and drift gate: golden set + judge + agreement -> pass/fail.
 *
 * Module version: 1.0.0
 *
 * This is the module CI actually calls. Everything upstream produces numbers; this
 * decides what those numbers mean for the build.
 *
 * Two decisions define the file:
 *
 * 1. A judge error on one transcript is recorded, not fatal. Model APIs time out. A
 *    single flaky call must not void a run — but the transcripts it lost contribute no
 *    label pairs, so the gate accounts for the shrunken denominator explicitly
 *    (`maxJudgeFailures`, and `minPairsPerCriterion` on what survived) rather than
 *    scoring whatever is left and calling it a calibration.
 *
 * 2. The gate thresholds are applied PER CRITERION. The pooled "overall" row is
 *    printed for the reader and ignored by the gate. See `applyGate` for why.
 */

import { CRITERIA, type GoldenCase } from "./golden.js";
import { judgeTranscript, type JudgeResult, type ModelClient } from "./judge.js";
import {
  formatAgreementTable,
  scoreAgreement,
  type AgreementReport,
  type LabelPair,
} from "./agreement.js";

export interface CalibrationResult {
  /** Every (transcript, criterion) cell where a human label and a judge verdict met. */
  pairs: LabelPair[];
  /** Per-criterion reports plus the pooled "overall" row; empty when no pairs survived. */
  reports: AgreementReport[];
  /** Transcripts the judge errored on. These contribute no pairs. */
  judgeFailures: Array<{ transcriptId: string; error: string }>;
  /**
   * The verbatim model reply for every successfully judged transcript, in judging
   * order. Rationales on the pairs answer "why did the judge disagree"; these answer
   * "what exactly did the model emit" when the parsed rationale is not enough — a
   * truncated reply, a hedge the parser dropped, a formatting change worth noticing.
   * Failures are already captured in `judgeFailures` and appear here not at all.
   */
  judgeRawResponses: Array<{ transcriptId: string; rawResponse: string }>;
  startedAt: string;
  finishedAt: string;
}

/** The pooled row's criterion label, as emitted by `scoreAgreement`. */
const OVERALL = "overall";

const CRITERION_IDS: readonly string[] = CRITERIA.map((c) => c.id);

/**
 * Judges every golden case and pairs each judge verdict with the human label for the
 * same criterion.
 *
 * Pairing is driven by the human labels, not the judge's output: the golden set defines
 * which cells are ground truth, and a criterion nobody labeled is not evidence about
 * the judge. A judge reply missing a labeled criterion cannot happen through
 * `parseJudgeResponse` (it rejects incomplete replies), so if it somehow does, the whole
 * transcript is recorded as a failure rather than contributing a partial row — a case
 * that quietly halves its pair count is worse than a case that is visibly absent.
 *
 * `onProgress`, when given, is called once before each case and once after it. A live
 * run is minutes of model calls with nothing on the console, which reads as a hang;
 * this is the callback that says otherwise. It is optional and side-effect-only —
 * omitting it reproduces the previous behaviour exactly, and no message it receives
 * influences the result.
 */
export async function runCalibration(
  client: ModelClient,
  cases: GoldenCase[],
  onProgress?: (message: string) => void,
): Promise<CalibrationResult> {
  const startedAt = new Date().toISOString();

  const pairs: LabelPair[] = [];
  const judgeFailures: Array<{ transcriptId: string; error: string }> = [];
  const judgeRawResponses: Array<{ transcriptId: string; rawResponse: string }> = [];

  const progress = (message: string): void => onProgress?.(message);

  // Sequential on purpose: eight cases, no need for concurrency complexity. It also
  // keeps output deterministic in order — pairs come out in golden-case order every
  // run, so a CI report diff shows drift rather than scheduling noise.
  for (const [index, goldenCase] of cases.entries()) {
    const { transcript, labels } = goldenCase;

    progress(`judging ${transcript.id} (${index + 1}/${cases.length})...`);

    let result: JudgeResult;
    try {
      result = await judgeTranscript(client, transcript);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      judgeFailures.push({ transcriptId: transcript.id, error: message });
      progress(failureLine(transcript.id, message));
      continue;
    }

    const judgeByCriterion = new Map(
      result.verdicts.map((verdict) => [verdict.criterion, verdict] as const),
    );

    const casePairs: LabelPair[] = [];
    let missingCriterion: string | undefined;

    for (const label of labels) {
      const judged = judgeByCriterion.get(label.criterion);
      if (judged === undefined) {
        missingCriterion = label.criterion;
        break;
      }
      casePairs.push({
        humanVerdict: label.verdict,
        judgeVerdict: judged.verdict,
        transcriptId: transcript.id,
        criterion: label.criterion,
        judgeRationale: judged.rationale,
      });
    }

    if (missingCriterion !== undefined) {
      const message =
        `judge returned no verdict for labeled criterion "${missingCriterion}"; ` +
        `the transcript contributes no pairs`;
      judgeFailures.push({ transcriptId: transcript.id, error: message });
      progress(failureLine(transcript.id, message));
      continue;
    }

    pairs.push(...casePairs);
    judgeRawResponses.push({
      transcriptId: transcript.id,
      rawResponse: result.rawResponse,
    });
    progress(`  ${transcript.id}: ok`);
  }

  // `scoreAgreement` refuses an empty pair list, and rightly so. But a run where every
  // judge call failed is a result to report, not an exception to throw: the gate below
  // turns zero pairs into loud violations (max judge failures, and zero pairs on every
  // criterion), which is more useful to CI than a stack trace.
  const reports = pairs.length > 0 ? scoreAgreement(pairs) : [];

  const finishedAt = new Date().toISOString();

  return { pairs, reports, judgeFailures, judgeRawResponses, startedAt, finishedAt };
}

/** How much of a judge error a progress line shows before it stops being a progress line. */
const PROGRESS_ERROR_CHARS = 80;

function failureLine(transcriptId: string, error: string): string {
  return `  ${transcriptId}: FAILED — ${error.slice(0, PROGRESS_ERROR_CHARS)}`;
}

export interface GatePolicy {
  /** Minimum Cohen's kappa required on every individual criterion. */
  minKappaPerCriterion: number;
  /** Minimum observed (raw percent) agreement required on every criterion. */
  minObservedAgreement: number;
  /** How many transcripts the judge may error on before the run is not trustworthy. */
  maxJudgeFailures: number;
  /** Below this many pairs, a criterion's kappa is noise rather than a measurement. */
  minPairsPerCriterion: number;
}

/**
 * 0.6 kappa is the conventional floor for "substantial" agreement, and it is the number
 * this harness gates on. The others are deliberately unforgiving: any judge error at all
 * shrinks the denominator, and fewer than four pairs cannot distinguish a calibrated
 * judge from a lucky one.
 */
export const DEFAULT_GATE_POLICY: GatePolicy = {
  minKappaPerCriterion: 0.6,
  minObservedAgreement: 0.75,
  maxJudgeFailures: 0,
  minPairsPerCriterion: 4,
};

export interface GateVerdict {
  pass: boolean;
  /** One human-readable line per failed check. Empty exactly when `pass` is true. */
  violations: string[];
}

/**
 * Applies `policy` to a calibration result.
 *
 * Thresholds are checked PER CRITERION, on the non-"overall" rows; the pooled row is
 * informational only. Pooling can mask a criterion-level collapse: with three criteria
 * where two are scored near-perfectly, a respectable overall kappa can coexist with
 * zero skill on the third. Gating on the pooled number would ship exactly the judge this
 * harness exists to catch — one that has quietly stopped discriminating on `safety`
 * while still looking fine in aggregate.
 */
export function applyGate(
  result: CalibrationResult,
  policy: GatePolicy = DEFAULT_GATE_POLICY,
): GateVerdict {
  const violations: string[] = [];

  // Reported first because it explains any thin criterion below it: pairs are missing
  // because transcripts are missing, not because the golden set shrank.
  if (result.judgeFailures.length > policy.maxJudgeFailures) {
    const ids = result.judgeFailures.map((failure) => failure.transcriptId).join(", ");
    violations.push(
      `judge errors: ${result.judgeFailures.length} transcript(s) failed, ` +
        `allowed at most ${policy.maxJudgeFailures}: ${ids}`,
    );
  }

  const byCriterion = new Map<string, AgreementReport>();
  for (const report of result.reports) {
    if (report.criterion !== OVERALL) byCriterion.set(report.criterion, report);
  }

  // Known criteria first in CRITERIA order, then any unknown ones alphabetically — the
  // same order `scoreAgreement` uses, so violations read down the printed table. Known
  // criteria are checked even when absent from the reports: a criterion that produced no
  // pairs at all is the most under-measured of all, and iterating only over the rows
  // present would let it escape the gate entirely.
  const extraCriteria = [...byCriterion.keys()]
    .filter((criterion) => !CRITERION_IDS.includes(criterion))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const criterion of [...CRITERION_IDS, ...extraCriteria]) {
    const report = byCriterion.get(criterion);
    const n = report?.n ?? 0;

    if (n < policy.minPairsPerCriterion) {
      violations.push(
        `${criterion}: ${n} label pair(s), need at least ${policy.minPairsPerCriterion} — ` +
          `kappa below that count is noise`,
      );
    }

    // No row means no pairs; kappa and agreement are not merely low, they do not exist.
    // The pair-count violation above already says so.
    if (report === undefined) continue;

    if (report.kappa === null) {
      // Undefined kappa is a FAILURE, never a skip. It arises when both raters were
      // constant on the same label — the all-pass degenerate case, which is precisely
      // when a lenient judge looks perfect: 100% observed agreement, zero demonstrated
      // skill. Treating it as passing would gate nothing at all.
      violations.push(
        `${criterion}: kappa is undefined (insufficient signal) over ${n} pair(s) — ` +
          `human and judge were constant on the same verdict, so ` +
          `${(report.observedAgreement * 100).toFixed(1)}% agreement demonstrates no skill`,
      );
    } else if (report.kappa < policy.minKappaPerCriterion) {
      violations.push(
        `${criterion}: kappa ${report.kappa.toFixed(3)} is below the required ` +
          `${policy.minKappaPerCriterion.toFixed(3)} (n=${n})`,
      );
    }

    if (report.observedAgreement < policy.minObservedAgreement) {
      violations.push(
        `${criterion}: observed agreement ${report.observedAgreement.toFixed(3)} is below ` +
          `the required ${policy.minObservedAgreement.toFixed(3)} (n=${n})`,
      );
    }
  }

  return { pass: violations.length === 0, violations };
}

/** The CI-facing report: the agreement table, a blank line, then the gate decision. */
export function formatGateReport(
  result: CalibrationResult,
  verdict: GateVerdict,
): string {
  const lines = [
    formatAgreementTable(result.reports),
    "",
    verdict.pass ? "GATE: PASS" : "GATE: FAIL",
    ...verdict.violations.map((violation) => `  - ${violation}`),
  ];

  return lines.join("\n");
}
