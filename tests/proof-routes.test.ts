/**
 * Proof over HTTP (specs/011 phase 5): `GET /api/sessions/:sid/proof`, the user's create/edit,
 * `not-applicable` with a reason, the `proof/v1` export, the SSE `proof_updated` frame, and the
 * USER-only goal override. A real server and a scripted provider; the ledger every surface shows is
 * the one these routes return.
 */
import type { GoalInfo, ProofLedger, ProviderEvent, ServerFrame } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { InteractionBridge } from "../packages/server/src/bridges/interaction-bridge.ts";
import {
  fakeProvider,
  newSession,
  openStream,
  raw,
  reply,
  settled,
  startTestServer,
  type TestServer,
  until,
} from "./server-helpers.ts";

let t: TestServer | undefined;
const streams: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  await t?.close();
  t = undefined;
});
const server = () => t as TestServer;
const proofPath = (id: string, suffix = "") => `/api/sessions/${id}/proof${suffix}`;
const ledgerOf = async (id: string) => (await server().api.get(proofPath(id))).json<ProofLedger>();

async function start(provider = fakeProvider(() => reply("ok")), app: object = {}) {
  t = await startTestServer({ provider, app });
  return (await newSession(t, { preset: "full-access" })).id;
}

describe("Proof routes: auth and validation", () => {
  it("refuses a request without the session cookie and a write without Origin", async () => {
    const id = await start();
    expect((await raw(server().server.port, proofPath(id))).status).toBe(401);
    const noOrigin = await raw(server().server.port, proofPath(id, "/criteria"), {
      method: "POST",
      headers: { Cookie: server().cookie, "Content-Type": "application/json" },
      body: { text: "x" },
    });
    expect(noOrigin.status).toBe(403);
  });

  it("returns an empty ledger for a session without criteria and 404 for an unknown session", async () => {
    const id = await start();
    const ledger = await ledgerOf(id);
    expect(ledger).toMatchObject({ sessionId: id, criteria: [], evidence: [], divergences: [] });
    expect((await server().api.get(proofPath("nope"))).status).toBe(404);
  });

  it("rejects an invalid criterion with field paths only", async () => {
    const id = await start();
    const empty = await server().api.post(proofPath(id, "/criteria"), { text: "  " });
    expect(empty.status).toBe(400);
    const unknown = await server().api.post(proofPath(id, "/criteria"), { text: "x", evil: 1 });
    expect(unknown.status).toBe(400);
    expect(
      unknown.json<{ error: { details: { fields: string[] } } }>().error.details.fields,
    ).toEqual(["evil"]);
    const badVerifier = await server().api.post(proofPath(id, "/criteria"), {
      text: "x",
      verifier: { kind: "plugin", verifierId: "p" },
    });
    expect(badVerifier.status).toBe(400);
  });
});

describe("Proof routes: the user's criteria", () => {
  it("creates a user criterion (not required by default) and lists it as not_checked", async () => {
    const id = await start();
    const res = await server().api.post(proofPath(id, "/criteria"), {
      text: "Tests pass",
      verify: "pnpm test",
    });
    expect(res.status).toBe(200);
    const ledger = res.json<ProofLedger>();
    expect(ledger.criteria).toHaveLength(1);
    expect(ledger.criteria[0]).toMatchObject({
      text: "Tests pass",
      origin: "user",
      required: false,
      status: "not_checked",
      verifier: { kind: "command", command: "pnpm test" },
    });
    expect(await ledgerOf(id)).toMatchObject({ criteria: [{ text: "Tests pass" }] });
  });

  it("edits the wording and the required flag, but never the verifier", async () => {
    const id = await start();
    const created = (
      await server().api.post(proofPath(id, "/criteria"), { text: "a", verify: "pnpm lint" })
    ).json<ProofLedger>();
    const criterionId = created.criteria[0]?.criterionId as string;
    const edited = await server().api.post(proofPath(id, "/criteria"), {
      criterionId,
      text: "Lint is clean",
      required: true,
    });
    expect(edited.json<ProofLedger>().criteria[0]).toMatchObject({
      text: "Lint is clean",
      required: true,
      verifier: { kind: "command", command: "pnpm lint" },
    });
    const withVerifier = await server().api.post(proofPath(id, "/criteria"), {
      criterionId,
      verify: "other",
    });
    expect(withVerifier.status).toBe(400);
    expect(
      (await server().api.post(proofPath(id, "/criteria"), { criterionId: "crit_none", text: "x" }))
        .status,
    ).toBe(404);
  });

  it("marks a criterion not applicable only with a reason, and keeps it out of the unmet count", async () => {
    const id = await start();
    const created = (
      await server().api.post(proofPath(id, "/criteria"), { text: "a", required: true })
    ).json<ProofLedger>();
    const criterionId = created.criteria[0]?.criterionId as string;
    const path = proofPath(id, `/criteria/${criterionId}/not-applicable`);
    expect((await server().api.post(path, {})).status).toBe(400);
    expect((await server().api.post(path, { reason: "   " })).status).toBe(400);
    const done = await server().api.post(path, { reason: "No UI in this change" });
    expect(done.status).toBe(200);
    expect(done.json<ProofLedger>().criteria[0]).toMatchObject({
      status: "not_applicable",
      notApplicableReason: "No UI in this change",
    });
    expect(
      (
        await server().api.post(proofPath(id, "/criteria/crit_none/not-applicable"), {
          reason: "x",
        })
      ).status,
    ).toBe(404);
  });

  it("does not touch a criterion of another session", async () => {
    const id = await start();
    const other = (await newSession(server(), { preset: "full-access" })).id;
    const created = (
      await server().api.post(proofPath(other, "/criteria"), { text: "mine" })
    ).json<ProofLedger>();
    const criterionId = created.criteria[0]?.criterionId as string;
    expect(
      (
        await server().api.post(proofPath(id, `/criteria/${criterionId}/not-applicable`), {
          reason: "x",
        })
      ).status,
    ).toBe(404);
    expect(
      (await server().api.post(proofPath(id, "/criteria"), { criterionId, text: "hijack" })).status,
    ).toBe(404);
  });

  it("refuses writes on an archived session but still reads", async () => {
    const id = await start();
    await server().api.patch(`/api/sessions/${id}`, { archived: true });
    expect((await server().api.post(proofPath(id, "/criteria"), { text: "x" })).status).toBe(400);
    expect((await server().api.get(proofPath(id))).status).toBe(200);
  });
});

describe("the stream snapshot", () => {
  it("says how many criteria the session has, and nothing at all without any (D7)", async () => {
    const id = await start();
    const snapshotOf = async () => {
      const s = openStream(server().server.port, server().cookie, [id]);
      streams.push(s);
      const e = await s.next((x) => x.frame.t === "snapshot");
      s.close();
      return e.frame as Extract<ServerFrame, { t: "snapshot" }>;
    };
    expect((await snapshotOf()).proof).toBeUndefined();
    await server().api.post(proofPath(id, "/criteria"), { text: "a" });
    await server().api.post(proofPath(id, "/criteria"), { text: "b" });
    expect((await snapshotOf()).proof).toEqual({ criteria: 2 });
  });
});

describe("Proof routes: export", () => {
  it("exports proof/v1 JSON and Markdown with the same statuses as the ledger", async () => {
    const id = await start();
    await server().api.post(proofPath(id, "/criteria"), { text: "Docs | updated", required: true });
    const ledger = await ledgerOf(id);
    const json = await server().api.get(proofPath(id, "/export?format=json"));
    expect(json.status).toBe(200);
    expect(String(json.headers["content-type"])).toContain("application/json");
    expect(String(json.headers["content-disposition"])).toContain("proof.json");
    const body = json.json<{ schema: string; criteria: ProofLedger["criteria"] }>();
    expect(body.schema).toBe("proof/v1");
    expect(body.criteria.map((c) => c.status)).toEqual(ledger.criteria.map((c) => c.status));
    const md = await server().api.get(proofPath(id, "/export?format=md"));
    expect(String(md.headers["content-type"])).toContain("text/markdown");
    expect(md.text).toContain("not_checked");
    expect(md.text).toContain("Docs \\| updated");
  });

  it("defaults to JSON and rejects another format", async () => {
    const id = await start();
    expect(
      (await server().api.get(proofPath(id, "/export"))).json<{ schema: string }>().schema,
    ).toBe("proof/v1");
    expect((await server().api.get(proofPath(id, "/export?format=pdf"))).status).toBe(400);
  });
});

/** A model that runs one process and then answers; the criterion decides what that proves. */
function processModel(exit: number) {
  return fakeProvider(async function* (request): AsyncGenerator<ProviderEvent> {
    if (request.messages.at(-1)?.role === "tool") {
      yield {
        type: "completed",
        message: { role: "assistant", text: "Finished", calls: [] },
        usage: { input: 1, output: 1 },
      };
      return;
    }
    yield {
      type: "completed",
      message: {
        role: "assistant",
        text: "",
        calls: [
          {
            id: "call_proof_1",
            name: "run_process",
            arguments: JSON.stringify({
              command: "node",
              args: ["-e", `process.exitCode=${exit}`],
            }),
          },
        ],
      },
      usage: { input: 1, output: 1 },
    };
  });
}

describe("Proof routes: parity with the run", () => {
  it("shows the evidence the runner captured, streams proof_updated and exports the same status", async () => {
    const id = await start(processModel(0), { allowProcess: true });
    await server().api.post(proofPath(id, "/criteria"), {
      text: "The check exits 0",
      required: true,
      verify: "node -e process.exitCode=0",
    });
    const s = openStream(server().server.port, server().cookie, [id]);
    streams.push(s);
    await s.next((e) => e.frame.t === "snapshot");
    const run = (
      await server().api.post(`/api/sessions/${id}/prompts`, { requestId: "r1", text: "go" })
    ).json<{ runId: string }>();
    const frame = await s.next(
      (e) =>
        e.frame.t === "event" &&
        (e.frame as Extract<ServerFrame, { t: "event" }>).event.type === "proof_updated",
    );
    expect(
      ((frame.frame as Extract<ServerFrame, { t: "event" }>).event.data as { status: string })
        .status,
    ).toBe("verified");
    await settled(server(), id, run.runId);
    const ledger = await ledgerOf(id);
    expect(ledger.criteria[0]).toMatchObject({ status: "verified" });
    expect(ledger.evidence[0]).toMatchObject({ callId: "call_proof_1", exitCode: 0, ok: true });
    const exported = (await server().api.get(proofPath(id, "/export?format=json"))).json<{
      criteria: ProofLedger["criteria"];
    }>();
    expect(exported.criteria[0]?.status).toBe("verified");
  });

  it("a failing command leaves the criterion failed", async () => {
    const id = await start(processModel(3), { allowProcess: true });
    await server().api.post(proofPath(id, "/criteria"), {
      text: "The check exits 0",
      required: true,
      verify: "node -e process.exitCode=3",
    });
    const run = (
      await server().api.post(`/api/sessions/${id}/prompts`, { requestId: "r1", text: "go" })
    ).json<{ runId: string }>();
    await settled(server(), id, run.runId);
    expect((await ledgerOf(id)).criteria[0]?.status).toBe("failed");
  });
});

describe("the user's goal override", () => {
  const goalOf = async (id: string) =>
    (await server().api.get(`/api/sessions/${id}/goal`)).json<{ goal: GoalInfo | null }>().goal;

  async function pausedGoal() {
    const id = await start();
    await server().api.put(`/api/sessions/${id}/goal`, { objective: "Ship the feature" });
    await server().api.post(`/api/sessions/${id}/goal/pause`, {});
    await until(async () => (await goalOf(id))?.status === "paused");
    await until(async () =>
      (await server().api.get(`/api/sessions/${id}/runs`))
        .json<Array<{ status: string }>>()
        .every((r) => r.status !== "queued" && r.status !== "running"),
    );
    return id;
  }

  it("requires a reason, and refuses when no required criterion is unmet", async () => {
    const id = await pausedGoal();
    const path = `/api/sessions/${id}/goal/override`;
    expect((await server().api.post(path, {})).status).toBe(400);
    expect((await server().api.post(path, { reason: "  " })).status).toBe(400);
    // Nothing unmet: there is nothing to override.
    expect((await server().api.post(path, { reason: "ship it" })).status).toBe(409);
    expect((await goalOf(id))?.status).toBe("paused");
  });

  it("completes the goal as user_override over an unmet required criterion", async () => {
    const id = await pausedGoal();
    await server().api.post(proofPath(id, "/criteria"), {
      text: "Tests pass",
      required: true,
      verify: "pnpm test",
    });
    const res = await server().api.post(`/api/sessions/${id}/goal/override`, {
      reason: "Verified by hand on the staging box",
    });
    expect(res.status).toBe(200);
    const goal = res.json<{ goal: GoalInfo }>().goal;
    expect(goal).toMatchObject({ status: "complete", reason: "user_override" });
    expect(goal.proof?.override?.reason).toBe("Verified by hand on the staging box");
  });

  it("is a user route only: a bad Origin is refused like every write", async () => {
    const id = await pausedGoal();
    const res = await raw(server().server.port, `/api/sessions/${id}/goal/override`, {
      method: "POST",
      headers: {
        Cookie: server().cookie,
        Origin: "http://evil.example",
        "Content-Type": "application/json",
      },
      body: { reason: "x" },
    });
    expect(res.status).toBe(403);
  });
});

describe("plan review answers: the per-criterion selection", () => {
  const hub = {
    toSession: () => undefined,
    toWorkspace: () => undefined,
    subscribers: () => 1,
    workspaceSubscribers: () => 1,
  };
  const plan = (withCriteria: boolean) =>
    ({
      title: "P",
      revision: 1,
      hash: "h",
      ...(withCriteria
        ? {
            acceptanceCriteria: [{ text: "a", required: true, origin: "inferred" }],
          }
        : {}),
    }) as never;
  const ask = (withCriteria: boolean) => {
    const bridge = new InteractionBridge({ hub, rootOf: (id) => id, workspaceOf: () => "w" });
    const result = bridge.uiFor("w").askQuestions({
      questions: [
        {
          id: "plan",
          question: "?",
          options: [
            { value: "approve", label: "A" },
            { value: "context", label: "C", textInput: { placeholder: "" } },
          ],
        },
      ],
      session: "root",
      plan: plan(withCriteria),
    } as never);
    return { bridge, result, id: bridge.pending("root")[0]?.interactionId ?? "" };
  };

  it("accepts plan:criteria only for a review that lists criteria, as a bounded string", async () => {
    const withDrafts = ask(true);
    expect(withDrafts.bridge.resolve(withDrafts.id, { plan: "approve", "plan:criteria": 5 })).toBe(
      "invalid",
    );
    expect(
      withDrafts.bridge.resolve(withDrafts.id, {
        plan: "approve",
        "plan:criteria": "x".repeat(20_001),
      }),
    ).toBe("invalid");
    expect(
      withDrafts.bridge.resolve(withDrafts.id, {
        plan: "approve",
        "plan:criteria": JSON.stringify({ reject: [0] }),
      }),
    ).toBe("resolved");
    expect(await withDrafts.result).toEqual({
      plan: "approve",
      "plan:criteria": JSON.stringify({ reject: [0] }),
    });
    const without = ask(false);
    expect(without.bridge.resolve(without.id, { plan: "approve", "plan:criteria": "{}" })).toBe(
      "invalid",
    );
  });
});
