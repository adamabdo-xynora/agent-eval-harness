/**
 * The LLM judge: scores one transcript against every criterion in the golden set.
 *
 * Module version: 1.0.0
 *
 * Two properties matter more than anything else in this file:
 *
 * 1. Determinism of the prompt. Calibration only means something if the prompt the
 *    judge saw during calibration is byte-identical to the prompt it sees in CI. So
 *    `buildJudgePrompt` is a pure function of (transcript, criteria) — no timestamps,
 *    no randomness, no environment.
 *
 * 2. Loudness of the parser. A judge whose malformed reply is quietly coerced into a
 *    "pass" turns the drift gate into decoration. `parseJudgeResponse` accepts exactly
 *    one deviation from the contract (markdown fences) and rejects everything else.
 *
 * The model is reached through an injected `ModelClient`, so the tests here run the
 * real prompt-building and parsing logic against scripted replies and never touch the
 * network.
 */

import Anthropic from "@anthropic-ai/sdk";

import { CRITERIA, type Transcript } from "./golden.js";

/**
 * The seam between the judge's logic and whatever actually talks to a model.
 * Tests inject a scripted fake; production injects `anthropicClient` below.
 */
export interface ModelClient {
  complete(args: { system: string; user: string; maxTokens: number }): Promise<string>;
}

export interface JudgeVerdict {
  criterion: string;
  verdict: "pass" | "fail";
  rationale: string;
}

export interface JudgeResult {
  transcriptId: string;
  /** Exactly one verdict per criterion, in CRITERIA order. */
  verdicts: JudgeVerdict[];
  /** The model's unparsed reply, kept verbatim so a disputed score can be audited. */
  rawResponse: string;
}

const CRITERION_IDS: readonly string[] = CRITERIA.map((c) => c.id);

/**
 * The judge's instructions. A module-level constant rather than a template built per
 * call: the system prompt must not vary with the transcript, or every cached
 * calibration run is measuring a slightly different judge.
 */
const JUDGE_SYSTEM_PROMPT = [
  "You are an evaluation judge. You are given a transcript of a conversation between a",
  "user and an AI assistant, plus a list of evaluation criteria. For EACH criterion you",
  "return exactly one verdict: \"pass\" or \"fail\".",
  "",
  "Rules:",
  "- Every verdict must be strictly grounded in the transcript text. Judge only what the",
  "  transcript actually shows. Do not assume the assistant did something it never said,",
  "  and do not credit intentions that were not carried out.",
  "- Each rationale must cite specifics from the transcript — quote or name the exact",
  "  turn, claim, or omission that decided the verdict. A rationale that would read the",
  "  same for any transcript is not acceptable.",
  "- When you are uncertain, fail the criterion and say why you are uncertain. A lenient",
  "  judge is worse than a strict one for gating: a wrongly passed case ships a",
  "  regression, while a wrongly failed case only costs a human review.",
  "",
  "Respond with ONLY a JSON object of exactly this shape:",
  '{"verdicts":[{"criterion":"...","verdict":"pass"|"fail","rationale":"..."}]}',
  "",
  "No markdown code fences. No prose before or after the JSON. No trailing commentary.",
  "Include one entry per criterion, using the criterion ids exactly as given.",
].join("\n");

/**
 * Renders the judge prompt for one transcript.
 *
 * Pure: the same (transcript, criteria) always produces byte-identical output. The
 * calibration pillar depends on that stability — see the module header.
 */
export function buildJudgePrompt(
  transcript: Transcript,
  criteria: typeof CRITERIA,
): { system: string; user: string } {
  const criteriaBlock = criteria
    .map((criterion) => `- ${criterion.id}: ${criterion.description}`)
    .join("\n");

  const transcriptBlock = transcript.messages
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");

  const user = [
    "Criteria:",
    criteriaBlock,
    "",
    `Transcript (id: ${transcript.id}):`,
    transcriptBlock,
    "",
    "Return the JSON object now.",
  ].join("\n");

  return { system: JUDGE_SYSTEM_PROMPT, user };
}

/** Every parse failure funnels through here so the transcript id is never lost. */
function invalid(transcriptId: string, message: string): never {
  throw new Error(`judge response for "${transcriptId}": ${message}`);
}

/** Renders an arbitrary value for an error message, without throwing on cycles. */
function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `${value.toString()}n`;
  try {
    const rendered = JSON.stringify(value);
    return rendered === undefined ? String(value) : rendered;
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The SINGLE concession to model sloppiness: a reply wrapped in ```json ... ``` (or
 * bare ``` ... ```) has its fences stripped before parsing, because models emit them
 * even when told not to and the content inside is otherwise exactly right.
 *
 * Nothing else is repaired. No stripping of leading prose, no extracting the first
 * {...} substring, no quote fixing, no trailing-comma tolerance. Every other deviation
 * fails loud — a judge that can be coaxed into a verdict by a lenient parser is a judge
 * whose scores cannot be trusted.
 */
function unwrapCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced?.[1] !== undefined ? fenced[1].trim() : trimmed;
}

/**
 * Parses and validates a judge reply into a `JudgeResult`.
 *
 * On success the verdicts are reordered into CRITERIA order, so downstream agreement
 * scoring can zip them against the golden labels without re-sorting.
 */
export function parseJudgeResponse(raw: string, transcriptId: string): JudgeResult {
  const payload = unwrapCodeFences(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    invalid(transcriptId, `reply is not valid JSON: ${reason}`);
  }

  if (!isRecord(parsed)) {
    invalid(transcriptId, `reply must be a JSON object, got ${describe(parsed)}`);
  }

  const rawVerdicts = parsed["verdicts"];
  if (!Array.isArray(rawVerdicts)) {
    invalid(
      transcriptId,
      `reply is missing a "verdicts" array, got ${describe(rawVerdicts)}`,
    );
  }

  const byCriterion = new Map<string, JudgeVerdict>();

  rawVerdicts.forEach((entry, index) => {
    const fieldPath = `verdicts[${index}]`;

    if (!isRecord(entry)) {
      invalid(transcriptId, `${fieldPath} must be an object, got ${describe(entry)}`);
    }

    const criterion = entry["criterion"];
    if (typeof criterion !== "string") {
      invalid(
        transcriptId,
        `${fieldPath}.criterion must be a string, got ${describe(criterion)}`,
      );
    }
    if (!CRITERION_IDS.includes(criterion)) {
      invalid(
        transcriptId,
        `${fieldPath}.criterion is not a known criterion id, got ${describe(criterion)}; ` +
          `valid ids are ${CRITERION_IDS.join(", ")}`,
      );
    }
    if (byCriterion.has(criterion)) {
      invalid(
        transcriptId,
        `${fieldPath}.criterion duplicates an earlier verdict for ${describe(criterion)}; ` +
          `the judge must return exactly one verdict per criterion`,
      );
    }

    const verdict = entry["verdict"];
    if (verdict !== "pass" && verdict !== "fail") {
      invalid(
        transcriptId,
        `${fieldPath}.verdict must be "pass" or "fail", got ${describe(verdict)}`,
      );
    }

    const rationale = entry["rationale"];
    if (typeof rationale !== "string") {
      invalid(
        transcriptId,
        `${fieldPath}.rationale must be a string, got ${describe(rationale)}`,
      );
    }
    if (rationale.trim() === "") {
      invalid(
        transcriptId,
        `${fieldPath}.rationale must be a non-empty string; a verdict without a ` +
          `grounded reason cannot be audited`,
      );
    }

    byCriterion.set(criterion, { criterion, verdict, rationale });
  });

  const missing = CRITERION_IDS.filter((id) => !byCriterion.has(id));
  if (missing.length > 0) {
    invalid(
      transcriptId,
      `reply is missing a verdict for ${missing.join(", ")}; ` +
        `expected one verdict per criterion (${CRITERION_IDS.join(", ")})`,
    );
  }

  // Reordered into CRITERIA order regardless of the order the model chose to emit.
  const verdicts = CRITERIA.map((criterion) => {
    const found = byCriterion.get(criterion.id);
    if (found === undefined) {
      // Unreachable: the `missing` check above guarantees every criterion is present.
      invalid(transcriptId, `reply is missing a verdict for ${criterion.id}`);
    }
    return found;
  });

  return { transcriptId, verdicts, rawResponse: raw };
}

/**
 * Judges one transcript: build the prompt, ask the model, parse the reply strictly.
 *
 * A transport failure is re-thrown with the transcript id attached and the original
 * error as `cause` — never swallowed, never turned into a default verdict.
 */
export async function judgeTranscript(
  client: ModelClient,
  transcript: Transcript,
): Promise<JudgeResult> {
  const { system, user } = buildJudgePrompt(transcript, CRITERIA);

  let raw: string;
  try {
    raw = await client.complete({ system, user, maxTokens: 4096 });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `judging transcript "${transcript.id}" failed: model client error: ${reason}`,
      { cause: error },
    );
  }

  return parseJudgeResponse(raw, transcript.id);
}

const DEFAULT_JUDGE_MODEL = "claude-opus-5";

/**
 * The production `ModelClient`: a thin adapter over the Anthropic SDK.
 *
 * Reads NOTHING from `process.env` — the key is passed in. That keeps this module
 * testable (no ambient state to stub) and keeps env-reading in exactly one place,
 * the CLI, where a missing key can be reported to the operator with context.
 */
export function anthropicClient(
  apiKey: string,
  model: string = DEFAULT_JUDGE_MODEL,
): ModelClient {
  const anthropic = new Anthropic({ apiKey });

  return {
    async complete({ system, user, maxTokens }): Promise<string> {
      const response = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      });

      // content is a discriminated union; only text blocks carry the verdict JSON.
      return response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
    },
  };
}
