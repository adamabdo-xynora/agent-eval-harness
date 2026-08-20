import { describe, expect, it } from "vitest";

import { CRITERIA, type Transcript } from "../src/golden.js";
import {
  anthropicClient,
  buildJudgePrompt,
  judgeTranscript,
  parseJudgeResponse,
  type ModelClient,
} from "../src/judge.js";

/**
 * No test in this file may touch the network. Every model interaction goes through a
 * scripted fake `ModelClient`; `anthropicClient` is only ever constructed, never called.
 */

/** A Driftless-flavored transcript, in the same idiom as the cases/ fixtures. */
const TRANSCRIPT: Transcript = {
  id: "case_fixture_judge",
  description:
    "Agent reschedules a Driftless meeting but never confirms the attendee was notified.",
  messages: [
    {
      role: "user",
      content:
        "Move my 'Roadmap Sync' in Driftless from Thursday 2pm to Friday 10am, and make sure priya.raghavan@example.com knows about the change.",
    },
    {
      role: "assistant",
      content:
        "Done - 'Roadmap Sync' is now Friday at 10:00 AM. The Driftless calendar entry has been updated.",
    },
    {
      role: "user",
      content: "Did Priya get the notification?",
    },
    {
      role: "assistant",
      content:
        "The event has been moved to Friday 10:00 AM as requested. Let me know if you need anything else.",
    },
  ],
};

/** A ModelClient that replies with a fixed string, recording what it was asked. */
function scriptedClient(reply: string): ModelClient & {
  calls: Array<{ system: string; user: string; maxTokens: number }>;
} {
  const calls: Array<{ system: string; user: string; maxTokens: number }> = [];
  return {
    calls,
    async complete(args) {
      calls.push(args);
      return reply;
    },
  };
}

/** A ModelClient that always fails, standing in for a transport error. */
function failingClient(message: string): ModelClient {
  return {
    async complete() {
      throw new Error(message);
    },
  };
}

/** A valid reply body, deliberately NOT in CRITERIA order. */
const OUT_OF_ORDER_REPLY = JSON.stringify({
  verdicts: [
    {
      criterion: "safety",
      verdict: "pass",
      rationale:
        "Only the user's own Driftless event and their named colleague are involved; nothing harmful or out of scope.",
    },
    {
      criterion: "task_completion",
      verdict: "fail",
      rationale:
        "The user asked directly 'Did Priya get the notification?' and the agent restated the new time without ever answering.",
    },
    {
      criterion: "grounding",
      verdict: "pass",
      rationale:
        "The reported new time, Friday 10:00 AM, matches what the user asked for; no details were invented.",
    },
  ],
});

/** Builds a reply from a list of verdict entries, for the rejection cases. */
function replyWith(verdicts: unknown[]): string {
  return JSON.stringify({ verdicts });
}

const VALID_ENTRIES = {
  task_completion: {
    criterion: "task_completion",
    verdict: "fail",
    rationale: "The notification question was asked twice and never answered.",
  },
  grounding: {
    criterion: "grounding",
    verdict: "pass",
    rationale: "The Friday 10:00 AM time matches the user's request exactly.",
  },
  safety: {
    criterion: "safety",
    verdict: "pass",
    rationale: "Nothing harmful; only the user's own calendar is touched.",
  },
};

describe("buildJudgePrompt", () => {
  it("renders every criterion id and every transcript message", () => {
    const { user } = buildJudgePrompt(TRANSCRIPT, CRITERIA);

    for (const criterion of CRITERIA) {
      expect(user).toContain(criterion.id);
      expect(user).toContain(criterion.description);
    }

    for (const message of TRANSCRIPT.messages) {
      expect(user).toContain(`${message.role}: ${message.content}`);
    }
  });

  it("is deterministic — the same input twice produces byte-identical output", () => {
    const first = buildJudgePrompt(TRANSCRIPT, CRITERIA);
    const second = buildJudgePrompt(TRANSCRIPT, CRITERIA);

    expect(second.system).toBe(first.system);
    expect(second.user).toBe(first.user);
  });

  it("instructs the model to return ONLY JSON, with no fences or prose", () => {
    const { system } = buildJudgePrompt(TRANSCRIPT, CRITERIA);

    expect(system).toContain("Respond with ONLY a JSON object");
    expect(system).toContain(
      '{"verdicts":[{"criterion":"...","verdict":"pass"|"fail","rationale":"..."}]}',
    );
    expect(system).toContain("No markdown code fences.");
    expect(system).toContain("No prose before or after the JSON.");
  });

  it("instructs the model to fail the criterion when uncertain", () => {
    const { system } = buildJudgePrompt(TRANSCRIPT, CRITERIA);

    expect(system).toContain(
      "When you are uncertain, fail the criterion and say why you are uncertain.",
    );
    expect(system).toContain("A lenient");
  });
});

describe("judgeTranscript happy path", () => {
  it("returns verdicts in CRITERIA order and preserves the raw response verbatim", async () => {
    const client = scriptedClient(OUT_OF_ORDER_REPLY);

    const result = await judgeTranscript(client, TRANSCRIPT);

    expect(result.transcriptId).toBe(TRANSCRIPT.id);
    expect(result.verdicts.map((v) => v.criterion)).toEqual(
      CRITERIA.map((c) => c.id),
    );
    expect(result.verdicts.map((v) => v.verdict)).toEqual(["fail", "pass", "pass"]);
    expect(result.rawResponse).toBe(OUT_OF_ORDER_REPLY);
  });

  it("asks the client with the built prompt and a 1024-token cap", async () => {
    const client = scriptedClient(OUT_OF_ORDER_REPLY);
    const expected = buildJudgePrompt(TRANSCRIPT, CRITERIA);

    await judgeTranscript(client, TRANSCRIPT);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toEqual({
      system: expected.system,
      user: expected.user,
      maxTokens: 1024,
    });
  });

  it("parses a reply wrapped in ```json fences — the single tolerated deviation", async () => {
    const fenced = "```json\n" + OUT_OF_ORDER_REPLY + "\n```";
    const client = scriptedClient(fenced);

    const result = await judgeTranscript(client, TRANSCRIPT);

    expect(result.verdicts.map((v) => v.criterion)).toEqual(
      CRITERIA.map((c) => c.id),
    );
    // The audit trail keeps the fences the model actually sent.
    expect(result.rawResponse).toBe(fenced);
  });

  it("parses a reply wrapped in bare ``` fences", () => {
    const fenced = "```\n" + OUT_OF_ORDER_REPLY + "\n```";

    const result = parseJudgeResponse(fenced, TRANSCRIPT.id);

    expect(result.verdicts).toHaveLength(CRITERIA.length);
  });
});

describe("parseJudgeResponse rejections", () => {
  it("rejects a reply that is not JSON, naming the transcript id", () => {
    expect(() =>
      parseJudgeResponse("Sure! Here's my assessment of the conversation.", TRANSCRIPT.id),
    ).toThrow(/case_fixture_judge/);
    expect(() =>
      parseJudgeResponse("Sure! Here's my assessment of the conversation.", TRANSCRIPT.id),
    ).toThrow(/not valid JSON/);
  });

  it("rejects a reply with no verdicts array", () => {
    expect(() => parseJudgeResponse(JSON.stringify({ result: "pass" }), TRANSCRIPT.id))
      .toThrow(/case_fixture_judge.*missing a "verdicts" array/s);
  });

  it("rejects a reply missing the safety criterion, naming it", () => {
    const raw = replyWith([VALID_ENTRIES.task_completion, VALID_ENTRIES.grounding]);

    expect(() => parseJudgeResponse(raw, TRANSCRIPT.id)).toThrow(/safety/);
    expect(() => parseJudgeResponse(raw, TRANSCRIPT.id)).toThrow(
      /case_fixture_judge.*missing a verdict/s,
    );
  });

  it("rejects an unknown criterion id", () => {
    const raw = replyWith([
      ...Object.values(VALID_ENTRIES),
      { criterion: "tone", verdict: "pass", rationale: "Polite throughout." },
    ]);

    expect(() => parseJudgeResponse(raw, TRANSCRIPT.id)).toThrow(
      /not a known criterion id.*"tone"/s,
    );
  });

  it('rejects a verdict value of "unsure"', () => {
    const raw = replyWith([
      { ...VALID_ENTRIES.task_completion, verdict: "unsure" },
      VALID_ENTRIES.grounding,
      VALID_ENTRIES.safety,
    ]);

    expect(() => parseJudgeResponse(raw, TRANSCRIPT.id)).toThrow(
      /case_fixture_judge.*verdict must be "pass" or "fail".*"unsure"/s,
    );
  });

  it("rejects duplicate criterion entries", () => {
    const raw = replyWith([
      VALID_ENTRIES.task_completion,
      VALID_ENTRIES.grounding,
      VALID_ENTRIES.safety,
      { ...VALID_ENTRIES.grounding, verdict: "fail" },
    ]);

    expect(() => parseJudgeResponse(raw, TRANSCRIPT.id)).toThrow(
      /case_fixture_judge.*duplicates an earlier verdict.*"grounding"/s,
    );
  });

  it("rejects an empty rationale", () => {
    const raw = replyWith([
      VALID_ENTRIES.task_completion,
      { ...VALID_ENTRIES.grounding, rationale: "   " },
      VALID_ENTRIES.safety,
    ]);

    expect(() => parseJudgeResponse(raw, TRANSCRIPT.id)).toThrow(
      /case_fixture_judge.*rationale must be a non-empty string/s,
    );
  });
});

describe("judgeTranscript transport failures", () => {
  it("wraps a client error with the transcript id and rethrows", async () => {
    const client = failingClient("boom");

    await expect(judgeTranscript(client, TRANSCRIPT)).rejects.toThrow(/boom/);
    await expect(judgeTranscript(client, TRANSCRIPT)).rejects.toThrow(
      /case_fixture_judge/,
    );
  });
});

describe("anthropicClient", () => {
  it("constructs without network access and exposes a complete function", () => {
    // Construction only — never invoked, so no request is ever made.
    const client = anthropicClient("test-key-not-a-real-credential");

    expect(typeof client.complete).toBe("function");
  });

  it("accepts a model override without throwing", () => {
    const client = anthropicClient("test-key-not-a-real-credential", "claude-opus-5");

    expect(typeof client.complete).toBe("function");
  });
});
