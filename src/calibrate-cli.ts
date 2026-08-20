/**
 * The CI entry point: run a live calibration against the golden set and apply the gate.
 *
 * Module version: 1.0.0
 *
 * THIS IS THE ONLY FILE IN THE PROJECT THAT READS `process.env`. Every other module
 * takes its configuration as a parameter — `anthropicClient` is handed a key, the gate
 * is handed a policy, the loader is handed a directory. That discipline is what makes
 * the rest of the harness testable without ambient state, and it is why this file is
 * the one place a missing key can be reported to an operator with real context.
 *
 * The corollary is that everything env-shaped lives here, and the interesting parts of
 * it — dotenv parsing, key resolution, argv parsing — are exported as pure functions so
 * the tests can exercise them without spawning a process or touching the real
 * environment. `main` is a thin shell over those functions plus I/O.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { argv, cwd, env, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import {
  applyGate,
  DEFAULT_GATE_POLICY,
  formatGateReport,
  runCalibration,
  type CalibrationResult,
  type GateVerdict,
} from "./calibrate.js";
import { loadGoldenSet, type GoldenCase } from "./golden.js";
import { anthropicClient } from "./judge.js";

/** Shipped in `.env` so a fresh clone has something to replace, not something that works. */
const PLACEHOLDER_KEY = "<paste-your-key-here>";

const API_KEY_VAR = "ANTHROPIC_API_KEY";

const DEFAULT_CASES_DIR = "cases";

const RESULTS_DIR = "results";

/**
 * The judge model this CLI pins when `--model` is absent.
 *
 * Deliberately named here rather than left to `anthropicClient`'s own default: the run
 * artifact records the model id that produced the numbers, and a calibration whose
 * artifact says "whatever the default was that day" is not auditable. Passing it
 * explicitly means the recorded id and the id actually used cannot drift apart.
 */
const DEFAULT_JUDGE_MODEL = "claude-opus-5";

/** Configuration is wrong (missing key, unreadable cases dir). Nothing was measured. */
const EXIT_CONFIG_ERROR = 2;

/**
 * The gate failed. This exit code is the entire point of the module: `npx tsx
 * src/calibrate-cli.ts` in a CI step turns judge drift into a red build. A harness that
 * printed "GATE: FAIL" and exited 0 would be a report, not a gate.
 */
const EXIT_GATE_FAILED = 1;

const EXIT_OK = 0;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * A 15-line `.env` parser, deliberately hand-rolled instead of adding `dotenv`.
 *
 * Two reasons. One less runtime dependency in a harness whose whole job is to be
 * trusted by CI — a supply-chain surface for `KEY=VALUE` is a bad trade. And the
 * parser is short enough to read in full below, so its behaviour on the cases that
 * actually matter here (quotes, comments, `=` inside a value) is verifiable by
 * inspection rather than by reading someone else's changelog.
 *
 * What it does NOT do, on purpose: multi-line values, `export ` prefixes, variable
 * interpolation. This file needs one API key out of one line.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    // Split on the FIRST `=` only: a base64-ish key can legitimately contain `=`, and
    // splitting on all of them would silently truncate it.
    const separator = line.indexOf("=");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    if (key === "") continue;

    // Later duplicates win — same as a shell sourcing the file top to bottom.
    result[key] = unquote(line.slice(separator + 1).trim());
  }

  return result;
}

/** Strips one matching pair of surrounding single or double quotes, if present. */
function unquote(value: string): string {
  if (value.length < 2) return value;

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && last === first) {
    return value.slice(1, -1);
  }

  return value;
}

/**
 * Resolves the API key from the environment, falling back to a `.env` file's contents.
 *
 * Takes the environment as a parameter rather than reading `process.env` itself, so the
 * tests never depend on — or mutate — the real environment.
 *
 * Precedence: the environment variable wins over `.env`. CI sets a secret in the
 * environment; `.env` is the local-development convenience, and a checked-out `.env`
 * must never override what CI injected.
 *
 * The placeholder is checked AFTER precedence, on whichever source won. A placeholder
 * is a distinct failure from a missing key — it means the operator has the file and has
 * not filled it in — so it earns its own message pointing at `.env` rather than a
 * generic "not set".
 *
 * No error string this function returns ever contains a key value from any source.
 * The whole point of a key is that it does not appear in logs, and a CI job's console
 * is a log that outlives the run.
 */
export function resolveApiKey(
  env: Record<string, string | undefined>,
  dotEnvContent: string | null,
): { key: string } | { error: string } {
  const fromEnv = env[API_KEY_VAR]?.trim();
  const fromDotEnv = dotEnvContent === null ? undefined : parseDotEnv(dotEnvContent)[API_KEY_VAR]?.trim();

  const candidate = fromEnv !== undefined && fromEnv !== "" ? fromEnv : fromDotEnv;

  if (candidate === undefined || candidate === "") {
    return {
      error:
        `${API_KEY_VAR} is not set. Put a real key in .env at the project root ` +
        `(${API_KEY_VAR}=sk-ant-...) or export it in your shell before running.`,
    };
  }

  if (candidate === PLACEHOLDER_KEY) {
    return {
      error:
        `${API_KEY_VAR} is still the placeholder shipped in .env. Replace it with a ` +
        `real key (.env is gitignored, so it will not be committed).`,
    };
  }

  return { key: candidate };
}

export interface CliArgs {
  casesDir: string;
  model?: string;
}

/**
 * Parses `[casesDir] [--model <id>]`.
 *
 * Unknown flags THROW rather than being ignored. A calibration run costs real model
 * calls, and silently ignoring `--modle claude-opus-5` would spend them measuring a
 * model the operator did not ask for and then record the wrong id in the artifact. A
 * typo should cost a re-run, not a wrong number.
 */
export function pickArgs(argv: string[]): CliArgs {
  let casesDir: string | undefined;
  let model: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;

    if (token === "--model" || token.startsWith("--model=")) {
      const inline = token.startsWith("--model=") ? token.slice("--model=".length) : undefined;
      const value = inline ?? argv[++i];

      if (value === undefined || value === "") {
        throw new Error("--model requires a model id, e.g. --model claude-opus-5");
      }
      model = value;
      continue;
    }

    if (token.startsWith("-")) {
      throw new Error(`unknown option "${token}" — usage: calibrate-cli [casesDir] [--model <id>]`);
    }

    if (casesDir !== undefined) {
      throw new Error(
        `unexpected extra argument "${token}" — exactly one cases directory may be given`,
      );
    }
    casesDir = token;
  }

  // Built conditionally: `exactOptionalPropertyTypes` distinguishes an absent `model`
  // from one explicitly set to `undefined`, and callers branch on `in`/`!== undefined`.
  const args: CliArgs = { casesDir: casesDir ?? DEFAULT_CASES_DIR };
  if (model !== undefined) args.model = model;
  return args;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Reads `.env` from the working directory, or null when there isn't one. */
async function readDotEnv(): Promise<string | null> {
  try {
    return await readFile(join(cwd(), ".env"), "utf8");
  } catch {
    // Absent or unreadable `.env` is not an error — the key may come from the
    // environment. `resolveApiKey` decides whether anything is actually missing.
    return null;
  }
}

/**
 * Belt-and-braces redaction for anything printed after the key is known.
 *
 * `resolveApiKey` already never emits the key, and no message here interpolates it, but
 * a transport error from a third-party SDK is a string this file does not control. One
 * `replaceAll` is cheap insurance against a key reaching a CI log through a stack of
 * code that was never audited for it.
 */
function redact(message: string, key: string | undefined): string {
  if (key === undefined || key === "") return message;
  return message.split(key).join("***");
}

async function main(rawArgs: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = pickArgs(rawArgs);
  } catch (error) {
    stderr.write(`${describe(error)}\n`);
    return EXIT_CONFIG_ERROR;
  }

  // `.env` is only consulted when the environment does not already supply the key —
  // no point reading a file whose value would lose the precedence check anyway.
  const envValue = env[API_KEY_VAR]?.trim();
  const dotEnvContent = envValue === undefined || envValue === "" ? await readDotEnv() : null;

  const resolved = resolveApiKey(env, dotEnvContent);
  if ("error" in resolved) {
    stderr.write(`${resolved.error}\n`);
    return EXIT_CONFIG_ERROR;
  }
  const { key } = resolved;

  // Loader errors are already precise — they name the file and the field. Printing the
  // message alone, with no stack, keeps the operator's eye on the bad case file rather
  // than on this module's call frames.
  let cases: GoldenCase[];
  try {
    cases = await loadGoldenSet(args.casesDir);
  } catch (error) {
    stderr.write(`${redact(describe(error), key)}\n`);
    return EXIT_CONFIG_ERROR;
  }

  const model = args.model ?? DEFAULT_JUDGE_MODEL;

  let result: CalibrationResult;
  try {
    // Progress goes to stderr, never stdout: stdout carries the gate report, which a CI
    // step may pipe, diff, or redirect into an artifact. Interleaving per-case chatter
    // into that stream would corrupt the one output another program consumes. stderr is
    // for the human watching a multi-minute run wonder whether it has hung.
    result = await runCalibration(anthropicClient(key, model), cases, (message) =>
      stderr.write(`${redact(message, key)}\n`),
    );
  } catch (error) {
    // Per-transcript judge failures are recorded by `runCalibration`, not thrown, so
    // reaching here means something structural broke. Not a config error, and certainly
    // not a pass.
    stderr.write(`calibration run failed: ${redact(describe(error), key)}\n`);
    return EXIT_GATE_FAILED;
  }

  const verdict = applyGate(result, DEFAULT_GATE_POLICY);

  stdout.write(`${formatGateReport(result, verdict)}\n`);

  await writeArtifact(result, verdict, model, key);

  return verdict.pass ? EXIT_OK : EXIT_GATE_FAILED;
}

async function writeArtifact(
  result: CalibrationResult,
  verdict: GateVerdict,
  model: string,
  key: string,
): Promise<void> {
  // Colons are legal on POSIX and hostile on Windows and in URLs; `-` keeps the
  // filename sortable and portable while staying readable as a timestamp.
  const stamp = new Date().toISOString().split(":").join("-");
  const path = join(RESULTS_DIR, `calibration-${stamp}.json`);

  // The policy is recorded alongside the verdict on purpose: six months from now the
  // thresholds may have moved, and a stored "GATE: FAIL" is only interpretable next to
  // the numbers it was judged against.
  const artifact = { model, gate: verdict, policy: DEFAULT_GATE_POLICY, calibration: result };

  try {
    await mkdir(RESULTS_DIR, { recursive: true });
    await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    stdout.write(`\nwrote ${path}\n`);
  } catch (error) {
    // A disk problem must not flip the gate. The pass/fail decision was made from the
    // measurements and is already on stdout; losing the artifact is worth a loud
    // warning, not a different verdict.
    stderr.write(`warning: could not write ${path}: ${redact(describe(error), key)}\n`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Only run when executed directly, so the exported helpers can be imported by tests
// without the process trying to calibrate anything. `import.meta.url` is the ESM way;
// `require.main === module` does not exist here.
const invokedPath = argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath)) {
  exit(await main(argv.slice(2)));
}
