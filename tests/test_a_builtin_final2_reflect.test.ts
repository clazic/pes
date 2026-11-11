// SEL-52 final review 2/2 (~/hc-work/pes/logs/SEL-52-final-review-2.md), required N1 and N2, with their variants.
// Written BEFORE the fix: each block fails on the tree HEAD 1478901 and passes only when the fix is in.
//   N1  the key handed back inside the answer in ANY disguise (JSON-escaped once/twice/three times inside the
//       OpenAI `arguments` string, base64, %xx, a piece, a property name, an error body, an event stream, a cut-off
//       body) -> no business command, nothing in the history, DB, log, DTO, export or next request; unknown + blocked
//       where the answer was read, never a leak where it was not
//   N2  the model list (GET models) hands the key back -> the connection test fails with a fixed code; the key is in
//       no DTO, row, log or export; nothing is stored or switched
// Windows: no child process, no path comparison; the export folder lives under the temp HOME of the env.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FINISH,
  MODEL_A,
  SYNTHETIC_KEY,
  dispatches,
  ready_project,
  reauth,
  register_connection,
  rejects_one_of,
  open_stage,
  run_row,
  set_script,
  start_run,
  with_a_env,
  make_a_env,
  next_key,
  type AEnv,
  type Format,
  type ScriptedTurn,
} from "./helpers/a_builtin_env.ts";
import {
  DISGUISES,
  assert_clean,
  assert_key_nowhere,
  b64,
  count_rows,
  error_text,
  nested,
  pct,
  sleep,
  uni,
} from "./helpers/a_leak.ts";

const FORMATS: Format[] = ["openai_compatible", "anthropic"];

/** the run was stopped on an answer that carried the key: unknown + usage_unknown, one call, no business effect */
async function assert_stopped_unknown(env: AEnv, res: Awaited<ReturnType<typeof start_run>>, calls: number, label: string): Promise<void> {
  assert.equal(res.status, "blocked_usage", `${label}: the run is held for a person`);
  assert.equal(res.block_reason, "usage_unknown", label);
  await sleep(40);
  assert.equal(env.fake.calls.length, calls, `${label}: no next request was built from the polluted history`);
  const rows = dispatches(env, res.run_id);
  assert.equal(rows.length, calls, label);
  assert.equal(rows[calls - 1]!.state, "unknown", `${label}: the call is kept as unknown for a person to settle`);
  assert.equal(run_row(env, res.run_id).status, "blocked_usage", label);
}

// =========================================================================================================
// N1 — the key comes back in a disguise inside a SUCCESSFUL answer

const BUSINESS_TABLES = ["objects", "object_versions", "question_sets"] as const;

function business_counts(env: AEnv): number[] {
  return BUSINESS_TABLES.map((t) => count_rows(env, t));
}

interface Variant {
  label: string;
  turn: (format: Format) => ScriptedTurn;
}

/** OpenAI: the tool call's `arguments` STRING spells the key as \uXXXX (review N1), 1..3 JSON layers deep */
function arguments_variants(): Variant[] {
  const out: Variant[] = [];
  for (const level of [1, 2, 3]) {
    for (const upper of [false, true]) {
      out.push({
        label: `arguments string with the key at JSON layer ${level} (\\u escapes, ${upper ? "upper" : "lower"} case hex)`,
        turn: (format) =>
          format === "openai_compatible"
            ? {
                tools: [{ name: "decision.propose", args: { text: "x" } }],
                raw_arguments: [`{"text":"${uni(nested(level), upper)}"}`],
              }
            : { tools: [{ name: "decision.propose", args: { text: nested(level) } }] },
      });
    }
  }
  // the arguments string with a \uXXXX key as a property NAME and as an array element
  out.push({
    label: "arguments string with the key as a property name (\\u escaped)",
    turn: (format) =>
      format === "openai_compatible"
        ? { tools: [{ name: "decision.propose", args: {} }], raw_arguments: [`{"${uni(SYNTHETIC_KEY)}":"x"}`] }
        : { tools: [{ name: "decision.propose", args: { [SYNTHETIC_KEY]: "x" } }] },
  });
  out.push({
    label: "arguments string with the key inside an array of an array",
    turn: (format) =>
      format === "openai_compatible"
        ? { tools: [{ name: "decision.propose", args: {} }], raw_arguments: [`{"text":"x","more":[["${uni(SYNTHETIC_KEY)}"]]}`] }
        : { tools: [{ name: "decision.propose", args: { text: "x", more: [[SYNTHETIC_KEY]] } }] },
  });
  return out;
}

function disguise_variants(): Variant[] {
  const out: Variant[] = [];
  for (const d of DISGUISES) {
    out.push({
      label: `tool argument text: ${d.label}`,
      turn: () => ({ tools: [{ name: "decision.propose", args: { text: d.text } }] }),
    });
    out.push({
      label: `answer text next to a tool call: ${d.label}`,
      turn: () => ({ text: d.text, tools: [{ name: "context.get", args: {} }] }),
    });
    out.push({
      label: `answer text only: ${d.label}`,
      turn: () => ({ text: d.text }),
    });
  }
  return out;
}

for (const format of FORMATS) {
  for (const variant of [...arguments_variants(), ...disguise_variants()]) {
    test(`N1 ${format}: ${variant.label} -> no business command, nothing kept; unknown + blocked`, async () => {
      await with_a_env(format, async (env) => {
        await ready_project(env);
        const o = await open_stage(env, "plan");
        const before = business_counts(env);
        set_script(env, [variant.turn(format), FINISH]);
        const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
        await assert_stopped_unknown(env, res, 1, variant.label);
        assert.deepEqual(business_counts(env), before, "no note / question / artifact / version was created");
        await assert_key_nowhere(env, res, variant.label);
      });
    });
  }
}

// the key sits in a LATER turn of a run that already did business: the first turn's result stays, the second is held
for (const format of FORMATS) {
  test(`N1 ${format}: a clean first turn is adopted, the second turn spells the key in \\u escapes -> held, key nowhere`, async () => {
    await with_a_env(format, async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      const second: ScriptedTurn =
        format === "openai_compatible"
          ? { tools: [{ name: "decision.propose", args: { text: "x" } }], raw_arguments: [`{"text":"${uni(SYNTHETIC_KEY)}"}`] }
          : { tools: [{ name: "decision.propose", args: { text: SYNTHETIC_KEY } }] };
      set_script(env, [{ tools: [{ name: "context.get", args: {} }] }, second, FINISH]);
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.equal(res.status, "blocked_usage");
      assert.equal(res.block_reason, "usage_unknown");
      await sleep(40);
      assert.equal(env.fake.calls.length, 2, "the third request was never built");
      assert.equal(dispatches(env, res.run_id)[1]!.state, "unknown");
      await assert_key_nowhere(env, res, "second turn reflects the key");
    });
  });
}

// control: the same shapes WITHOUT the key still work (the check must not be a blanket refusal)
for (const format of FORMATS) {
  test(`N1 ${format}: control - JSON-escaped text that is not the key runs normally`, async () => {
    await with_a_env(format, async (env) => {
      await ready_project(env);
      const o = await open_stage(env, "plan");
      const clean = "안전한 문장 sk-not-the-key-0000";
      const turn: ScriptedTurn =
        format === "openai_compatible"
          ? { tools: [{ name: "decision.propose", args: { text: "x" } }], raw_arguments: [`{"text":"${uni(clean)}"}`] }
          : { tools: [{ name: "decision.propose", args: { text: clean } }] };
      set_script(env, [turn, FINISH]);
      const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
      assert.notEqual(res.block_reason, "usage_unknown");
      assert.equal(res.status, "succeeded");
      assert.equal(env.fake.calls.length, 2);
    });
  });
}

// ---------------------------------------------------------------------------
// the key in an ERROR body and in a stream / cut-off body: never kept, never sent on, never a success

interface BodyCase {
  label: string;
  turn: (format: Format, key_text: string) => ScriptedTurn;
}

const ERROR_FORMS: Array<{ label: string; text: string }> = [
  { label: "plain", text: SYNTHETIC_KEY },
  { label: "a piece", text: `x ${"8f3a91c7d2e4"} y` },
  { label: "base64", text: b64(SYNTHETIC_KEY) },
  { label: "%xx", text: pct(SYNTHETIC_KEY) },
  { label: "\\u escaped", text: uni(SYNTHETIC_KEY) },
];

function error_body(format: Format, key_text: string, where: "message" | "code" | "type"): unknown {
  const message = where === "message" ? key_text : "synthetic failure";
  const code = where === "code" ? key_text : "synthetic_code";
  const type = where === "type" ? key_text : "api_error";
  return format === "anthropic" ? { type: "error", error: { type, message, code } } : { error: { message, type, code } };
}

const BODY_CASES: BodyCase[] = [
  ...(["message", "code", "type"] as const).flatMap((where): BodyCase[] =>
    [400, 401, 429, 500].map((status) => ({
      label: `HTTP ${status}, error ${where} = the key`,
      turn: (format: Format, key_text: string): ScriptedTurn => ({
        http: { status, ...(status === 429 ? { headers: { "retry-after": "60" } } : {}), body: error_body(format, key_text, where) },
      }),
    })),
  ),
  {
    label: "HTTP 502 plain text body",
    turn: (_f, key_text) => ({ raw_body: { status: 502, content_type: "text/plain", text: `bad gateway for Bearer ${key_text}` } }),
  },
  {
    label: "200 event stream (openai delta / anthropic content_block_delta)",
    turn: (format, key_text) => ({
      raw_body: {
        content_type: "text/event-stream",
        text:
          format === "anthropic"
            ? `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"${key_text}"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`
            : `data: {"choices":[{"delta":{"content":"${key_text}"}}]}\n\ndata: [DONE]\n\n`,
      },
    }),
  },
  {
    label: "200 body cut off in the middle of the key",
    turn: (format, key_text) => ({
      raw_body: {
        text:
          format === "anthropic"
            ? `{"id":"m","type":"message","content":[{"type":"text","text":"${key_text}`
            : `{"id":"c","choices":[{"message":{"content":"${key_text}`,
      },
    }),
  },
  {
    label: "200 body that is not JSON at all",
    turn: (_f, key_text) => ({ raw_body: { content_type: "text/plain", text: `echo: ${key_text}` } }),
  },
];

for (const format of FORMATS) {
  for (const body of BODY_CASES) {
    for (const form of ERROR_FORMS) {
      test(`N1 ${format}: ${body.label}, key as ${form.label} -> kept nowhere, one attempt, not a success`, async () => {
        await with_a_env(format, async (env) => {
          await ready_project(env);
          const o = await open_stage(env, "plan");
          set_script(env, [body.turn(format, form.text), FINISH]);
          const res = await start_run(env, { stage_id: o.stage_id, round_id: o.round_id });
          assert.notEqual(res.status, "succeeded");
          await sleep(40);
          assert.equal(env.fake.calls.length, 1, "one attempt, no retry, no next request");
          const rows = dispatches(env, res.run_id);
          assert.equal(rows.length, 1);
          assert.notEqual(rows[0]!.state, "sent", "the dispatch is not left as an orphan 'sent'");
          assert.equal(run_row(env, res.run_id).status === "running", false);
          await assert_key_nowhere(env, res, `${body.label} / ${form.label}`);
        });
      });
    }
  }
}

// =========================================================================================================
// N2 — the model list hands the key back

/** model ids a provider could use to echo the key */
const MODEL_ECHOES: Array<{ label: string; ids: string[] }> = [
  { label: "the key as the id", ids: [SYNTHETIC_KEY] },
  { label: "a normal id and the key", ids: [MODEL_A, SYNTHETIC_KEY] },
  { label: "the key inside an id", ids: [`model-${SYNTHETIC_KEY}-v1`] },
  { label: "a piece of the key in an id", ids: ["model-8f3a91c7d2e4-v1"] },
  { label: "base64 of the key as an id", ids: [b64(SYNTHETIC_KEY)] },
  { label: "%xx of the key as an id", ids: [pct(SYNTHETIC_KEY)] },
  { label: "\\u escapes of the key as an id", ids: [uni(SYNTHETIC_KEY)] },
];

function listing_text(value: unknown): string {
  return JSON.stringify(value ?? null);
}

for (const format of FORMATS) {
  for (const echo of MODEL_ECHOES) {
    test(`N2 ${format}: test() when the model list has ${echo.label} -> failed with a fixed code, key nowhere`, async () => {
      await with_a_env(format, async (env) => {
        const dto = await register_connection(env);
        env.fake.models = echo.ids;
        const listing = await env.conns.test(env.ctx(next_key(env)), { reauth_code: await reauth(env), connection_id: dto.connection_id });
        assert.equal(listing.ok, false, "the connection test fails");
        assert.deepEqual(listing.models, [], "no echoed id is handed on");
        assert.match(String(listing.error_code), /^[a-z][a-z0-9_]*$/, "a fixed code");
        assert_clean(listing_text(listing), "the test() answer");
        // the stored test record and everything else
        const tests = env.db.all<Record<string, unknown>>("SELECT * FROM ai_connections WHERE id = ?", dto.connection_id);
        assert.equal(tests.length, 1);
        await assert_key_nowhere(env, listing, "a model list that echoes the key", listing);
      });
    });

    test(`N2 ${format}: register with a model list that has ${echo.label} -> refused, nothing saved, no key kept`, async () => {
      await with_a_env(format, async (env) => {
        env.fake.models = echo.ids;
        let thrown: unknown;
        try {
          await register_connection(env);
        } catch (error) {
          thrown = error;
        }
        assert.ok(thrown !== undefined, "the registration is refused");
        assert.equal((thrown as { code?: string }).code, "conflict", error_text(thrown));
        assert_clean(error_text(thrown), "the refusal");
        assert.equal(count_rows(env, "ai_connections"), 0, "no connection row");
        assert.equal(env.keys.keys.size, 0, "no secret was stored for a refused registration");
        await assert_key_nowhere(env, undefined, "a refused registration", error_text(thrown));
      });
    });

    test(`N2 ${format}: a key change whose model list has ${echo.label} -> refused, the old key stays`, async () => {
      await with_a_env(format, async (env) => {
        const old_key = "sk-synthetic-old-0000aaaa1111bbbb";
        env.fake.accepted_keys.add(old_key);
        const dto = await register_connection(env, { api_key: old_key });
        const before = env.db.get<{ key_ref: string; key_last4: string }>("SELECT key_ref, key_last4 FROM ai_connections WHERE id = ?", dto.connection_id)!;
        env.fake.models = echo.ids;
        let thrown: unknown;
        try {
          await env.conns.update(env.ctx(next_key(env)), { reauth_code: await reauth(env), connection_id: dto.connection_id, api_key: SYNTHETIC_KEY });
        } catch (error) {
          thrown = error;
        }
        assert.ok(thrown !== undefined, "the change is refused");
        assert.equal((thrown as { code?: string }).code, "conflict", error_text(thrown));
        const after = env.db.get<{ key_ref: string; key_last4: string }>("SELECT key_ref, key_last4 FROM ai_connections WHERE id = ?", dto.connection_id)!;
        assert.equal(after.key_last4, before.key_last4, "the database still holds the old key's last 4");
        assert.equal(env.keys.keys.get(after.key_ref), old_key, "the key store still holds the old key");
        assert.equal(env.keys.keys.size, 1);
        await assert_key_nowhere(env, undefined, "a key change with an echoing list", error_text(thrown));
      });
    });
  }
}

// the plain control: a normal model list is untouched by the new check
for (const format of FORMATS) {
  test(`N2 ${format}: control - a normal model list still tests ok and lists the models`, async () => {
    await with_a_env(format, async (env) => {
      const dto = await register_connection(env);
      const listing = await env.conns.test(env.ctx(next_key(env)), { reauth_code: await reauth(env), connection_id: dto.connection_id });
      assert.equal(listing.ok, true);
      assert.deepEqual([...listing.models].sort(), [MODEL_A, "synthetic-model-b"].sort());
    });
  });
}

// the error the update/register path shows for a failed listing carries no echoed id even when the provider's
// model list is long and the key is only the LAST entry
test("N2: the key is the last of many ids -> still refused as a whole", async () => {
  const env: AEnv = await make_a_env("openai_compatible");
  try {
    env.fake.models = Array.from({ length: 200 }, (_v, i) => `synthetic-model-${i}`).concat([SYNTHETIC_KEY]);
    await rejects_one_of(register_connection(env), "conflict");
    assert.equal(count_rows(env, "ai_connections"), 0);
    assert.equal(env.keys.keys.size, 0);
    await assert_key_nowhere(env, undefined, "a long model list with the key last");
  } finally {
    await env.close_all();
  }
});
