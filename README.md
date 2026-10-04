# agent-eval-harness

A small, honest harness for the hardest part of using an LLM as a judge: **proving the judge agrees with you before trusting it.**

It contains a golden set of labeled agent transcripts, an LLM judge, agreement scoring (raw agreement + hand-rolled Cohen's kappa), and a CI gate that fails when judge-human agreement drops below per-criterion thresholds. The interesting part is not the code — it's the calibration log below, which records five rubric-and-judge iterations, including one where **the judge caught an error in our own ground-truth labels.**

## The problem

Teams increasingly grade AI agents with other AI models. The unexamined assumption is that the judge's verdicts mean what you think they mean. This repo treats that assumption as a hypothesis to test: eight fictional support-agent transcripts (an invented scheduling product, "Driftless") are hand-labeled pass/fail on three criteria — task_completion, grounding, safety — and the judge's verdicts are scored against those labels.

Agreement alone is not enough. A judge that says "pass" to everything scores 87.5% agreement on a set with one failure. So the gate requires **Cohen's kappa >= 0.6 per criterion** (agreement corrected for chance), **observed agreement >= 0.75**, a minimum pair count, and zero unparseable judge replies. Kappa that is undefined — both raters constant, no signal — **fails** the gate rather than passing on a technicality. Pooled overall numbers are reported but never gate: pooling hides per-criterion collapse.

## Calibration log — what actually happened

Six live runs against claude-opus-5, in order, with nothing omitted. Artifacts for every run are in results/.

| run | task k | grounding k | safety k | overall agree | gate | what we learned |
|---|---|---|---|---|---|---|
| 1 | 1.000* | 0.000* | undef* | 66.7%* | FAIL | 5 of 8 judge replies truncated mid-JSON at a 1024-token cap (reasoning ate the budget). *Numbers are over the 3 surviving cases — the gate correctly refused to treat them as signal. |
| 2 | 0.500 | 0.040 | 1.000 | 66.7% | FAIL | All 8 complete at 4096 tokens. Grounding collapsed: 6 of 8 disagreements, all human-pass/judge-fail. |
| 3 | 0.500 | 0.040 | 0.385 | 58.3% | FAIL | Identical inputs to run 2; safety dropped from 1.000 to 0.385. **The judge is not deterministic run-to-run.** This run also persisted judge rationales for the first time — reading them revealed the grounding collapse was systematic: the judge demanded transcript-visible tool evidence, while our labels assumed the fiction's frame (the agent has live workspace access; tool calls aren't shown). Same criterion name, two different exams. |
| 4 | 1.000 | -0.143 | 1.000 | 91.7% | FAIL | We rewrote the three criterion descriptions to state the frame explicitly (labels unchanged). Task and safety went perfect. Grounding went *below chance* on 2 disagreements: our new "product knowledge counts" clause was too broad — the judge accepted case_004's fabricated pricing as product knowledge, even verifying that the invented arithmetic was internally consistent. And on case_008 the judge failed a case we had passed — correctly. See below. |
| 5 | 1.000 | 1.000 | 0.600 | 95.8% | PASS | Narrowed the product-knowledge clause (behavior/policies yes; prices, plan names, tier limits no) and flipped case_008's grounding label. Grounding perfect. Safety wobbled to exactly the 0.600 threshold on one borderline reading that two prior runs had passed — variance again, not rubric. |
| 6 | 1.000 | 1.000 | 1.000 | 100.0% | PASS | Confirmation run, zero changes. 24/24. |

### The judge corrected our ground truth

case_008 is a trap case: the agent cites a standup time (9:15) that *looks* fabricated unless you read the user's first message, where it was stated verbatim. The trap tests whether a judge condemns suspicious-but-grounded claims. The judge passed the trap — and then failed the case anyway, pointing at a sentence we had never scrutinized: *"Bookings can now land at 9:00 AM but will end before standup begins."* With the call duration just set to 30 minutes, a 9:00 booking ends at 9:30 — inside the 9:15-9:45 standup block. The fixture contains a genuine self-contradiction. We wrote it, labeled it pass, and missed it. The judge caught it in run 4, and we changed the label (the transcript itself is untouched — sanding fixtures to match verdicts would defeat the point). The original label and the correction are both recorded in cases/case_008.json's rationale.

### Disclosures

- The criterion descriptions were revised twice (runs 3->4 and 4->5) based on reading judge rationales. That is calibration — both graders must be given the same exam — but it means the final agreement numbers are for the *final* rubric, not the first draft.
- One golden label (case_008 / grounding) was changed after, and because of, judge output. We believe the judge was simply right; judge for yourself — the transcript is in the repo.
- Runs 5 and 6 both PASS, but run 5's safety kappa sat exactly at the threshold. Given the measured run-to-run variance (see run 2 vs 3), a single run should be treated as a sample, not a truth. We report the band: 95.8%-100% post-convergence.

## Limitations, stated plainly

- **n = 8.** Kappa over eight pairs per criterion is coarse; the minPairs gate (4) is the floor of meaningfulness, not respectability. This is a methodology demo, not a benchmark.
- **The judge is stochastic.** Identical inputs produced safety kappa of 1.000, 0.385, 1.000, 0.600, 1.000 across runs. Any single-run number, including our 100%, carries that error bar.
- **The transcripts are invented,** by the same people who wrote the labels. Real production transcripts are messier and would fight back harder.
- **Calibration is circular by one turn.** We tuned the rubric until the judge agreed with us; the check on that circularity is that labels changed only once, under evidence, in the judge's favor.

## Design decisions worth stealing

- **Kappa is hand-rolled and verified against a published worked example** (the Wikipedia a=20/b=5/c=10/d=15 -> k=0.40 case is a unit test). No stats dependency to trust blindly.
- **Undefined kappa fails the gate.** A unanimous judge on a unanimous slice demonstrates no skill; 100% agreement there is vacuous.
- **Judge rationales and raw responses persist in every artifact.** The single most useful debugging act in this project was reading *why* the judge disagreed. Rationale storage was added in run 3; runs 1-2 flew blind and it showed.
- **Strict verdict parsing.** Truncated or malformed judge JSON is a counted failure, never a guessed verdict.
- **One env read in the whole codebase** (src/calibrate-cli.ts). Every other module takes its dependencies as parameters, so 104 offline tests cover the full gate logic with fakes and run free in CI.
- **The artifact records the gate policy alongside the verdict** — a stored FAIL is only interpretable next to the thresholds it was judged against.

## Running it

    npm install
    npm test                         # offline: 104 tests, no API key needed
    npx tsx src/calibrate-cli.ts     # live: needs ANTHROPIC_API_KEY in env or .env

Exit codes: 0 = gate PASS, 1 = gate FAIL, 2 = setup error. Each run writes results/calibration-(timestamp).json with verdicts, rationales, raw judge responses, and the policy.

The same two things run in Docker, and the test image needs no key. `docker build --target test -t agent-eval-harness:test . && docker run --rm agent-eval-harness:test npm test` runs the 104 offline tests inside the image (the typecheck already ran during the build). `docker build -t agent-eval-harness .` produces the runtime image — compiled JavaScript, the golden set, the committed receipts, and the SDK; no test tooling, no key baked in. Run it with `docker run --rm -e ANTHROPIC_API_KEY agent-eval-harness`; add `-v "$PWD/results:/app/results"` to keep the artifact. Without a key it exits 2 with the same setup message as the CLI.

CI runs the offline suite on every push. The live calibration is a manually-dispatched job (Actions tab) for anyone with an ANTHROPIC_API_KEY secret configured — a gate FAIL fails the job.

### Container image

The runtime image is published to GHCR on every version tag, by a workflow whose gate runs the 104
tests and the typecheck inside the test image first — the push step is unreachable unless both pass.

    docker pull ghcr.io/adamabdo-xynora/agent-eval-harness:0.1.0
    docker run --rm -e ANTHROPIC_API_KEY ghcr.io/adamabdo-xynora/agent-eval-harness:0.1.0

It runs the compiled calibration CLI and carries the golden set and the six committed receipts; add
`-v "$PWD/results:/app/results"` to keep a new artifact. Without a key it exits 2 with the same
setup message as the local CLI. `--help` is not a flag it accepts — it exits 2 reporting an unknown
option and printing its usage line. Published for `linux/amd64` and `linux/arm64`.

## Adapting it

Replace cases/*.json with your own transcripts and labels, rewrite the criterion descriptions in src/golden.ts for your domain, run the calibration, and — this is the actual method — **read every disagreement rationale before deciding whether to fix the rubric, the judge, or your labels.** Expect to be wrong about at least one of your own labels.

MIT license.
