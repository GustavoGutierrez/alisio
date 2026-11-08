/**
 * Skill Builder API: `POST /api/workspaces/:wid/skills/draft` (the active model drafts a skill,
 * cancellable) and `POST /api/workspaces/:wid/skills` (validated, atomic write; project scope
 * needs a trusted workspace; the workspace reloads so the skill is active without a restart).
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillCreateResult, SkillDraft, SkillDraftResult, SkillInfo } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fakeProvider,
  gatedProvider,
  newSession,
  openStream,
  reply,
  settled,
  startTestServer,
  type TestServer,
  until,
} from "./server-helpers.ts";

const MODEL_DRAFT = {
  name: "Budget Report",
  description:
    "Builds monthly budget reports from spreadsheets. Use when the user asks for a budget summary.",
  body: "# Budget report\n\n1. Read the spreadsheet.\n2. Run `scripts/summarize.py`.\n",
  files: [
    {
      path: "scripts/summarize.py",
      content: "# Usage: summarize.py file.xlsx\nprint('ok')\n",
      purpose: "Totals",
    },
  ],
};

const draft = (over: Partial<SkillDraft> = {}): SkillDraft => ({
  name: "budget-report",
  description: MODEL_DRAFT.description,
  body: MODEL_DRAFT.body,
  files: [{ path: "scripts/summarize.py", content: MODEL_DRAFT.files[0]?.content ?? "" }],
  ...over,
});

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function start(options: { readOnly?: boolean; trusted?: boolean; text?: string } = {}) {
  const provider = fakeProvider(() => reply(options.text ?? JSON.stringify(MODEL_DRAFT)));
  const home = await mkdtemp(join(tmpdir(), "alisio-skills-home-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  t = await startTestServer({
    provider,
    app: {
      ...(options.readOnly ? { readOnly: true } : {}),
      ...(options.trusted === false ? {} : { trustProject: true }),
      builtins: [],
    },
  });
  const wid = (await t.api.get("/api/workspaces")).json<Array<{ id: string }>>()[0]?.id ?? "";
  return { t, wid, provider, home };
}

describe("POST /api/workspaces/:wid/skills/draft", () => {
  it("drafts a skill with the active model and the bundled guidance, tool-less", async () => {
    const { t, wid, provider } = await start();
    const res = await t.api.post(`/api/workspaces/${wid}/skills/draft`, {
      idea: "build monthly budget reports",
      when: "summarize my budget",
      include: { scripts: "yes", references: "no", templates: "auto" },
    });
    expect(res.status).toBe(200);
    const body = res.json<SkillDraftResult>();
    expect(body.draft).toMatchObject({
      name: "budget-report",
      generatedBy: "fake-model",
      guidance: "bundled:skill-authoring",
    });
    expect(body.errors).toEqual([]);
    expect(body.draft.files[0]?.path).toBe("scripts/summarize.py");
    const call = provider.calls.at(-1);
    expect(call?.tools).toEqual([]);
    expect(call?.instructions).toContain("Use when");
    expect(call?.messages[0]).toMatchObject({
      text: expect.stringContaining("summarize my budget"),
    });
  });

  it("reports hard errors of the model's draft instead of hiding them", async () => {
    const bad = JSON.stringify({ ...MODEL_DRAFT, body: "See `references/missing.md`." });
    const { t, wid } = await start({ text: bad });
    const res = await t.api.post(`/api/workspaces/${wid}/skills/draft`, { idea: "x" });
    expect(res.status).toBe(200);
    expect(res.json<SkillDraftResult>().errors.map((e) => e.code)).toContain("reference-missing");
  });

  it("refines a previous draft with feedback", async () => {
    const { t, wid, provider } = await start();
    const res = await t.api.post(`/api/workspaces/${wid}/skills/draft`, {
      idea: "budget",
      previous: draft(),
      feedback: "make it shorter",
    });
    expect(res.status).toBe(200);
    expect(provider.calls.at(-1)?.messages[0]).toMatchObject({
      text: expect.stringContaining("Requested changes: make it shorter"),
    });
  });

  it("validates the request", async () => {
    const { t, wid } = await start();
    const url = `/api/workspaces/${wid}/skills/draft`;
    expect((await t.api.post(url, { idea: "  " })).status).toBe(400);
    expect((await t.api.post(url, {})).status).toBe(400);
    expect((await t.api.post(url, { idea: "x".repeat(4001) })).status).toBe(400);
    expect((await t.api.post(url, { idea: "x", include: { scripts: "maybe" } })).status).toBe(400);
    expect((await t.api.post(url, { idea: "x", previous: { name: 1 } })).status).toBe(400);
    expect((await t.api.post(url, { idea: "x", extra: true })).status).toBe(400);
    expect((await t.api.post("/api/workspaces/nope/skills/draft", { idea: "x" })).status).toBe(404);
  });

  it("answers provider_unavailable when the model fails or answers without JSON", async () => {
    const { t, wid } = await start({ text: "I cannot help with that" });
    const res = await t.api.post(`/api/workspaces/${wid}/skills/draft`, { idea: "x" });
    expect(res.status).toBe(502);
    expect(res.json()).toMatchObject({ error: { code: "provider_unavailable" } });
  });

  it("aborts the model call when the client closes the request", async () => {
    let aborted = false;
    let started = false;
    const provider = fakeProvider(async function* (request) {
      started = true;
      await new Promise<void>((resolve) =>
        request.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      yield { type: "completed", message: { role: "assistant", text: "{}", calls: [] } };
    });
    t = await startTestServer({ provider, app: { trustProject: true, builtins: [] } });
    const wid = (await t.api.get("/api/workspaces")).json<Array<{ id: string }>>()[0]?.id ?? "";
    const req = httpRequest({
      host: "127.0.0.1",
      port: t.server.port,
      path: `/api/workspaces/${wid}/skills/draft`,
      method: "POST",
      headers: {
        Cookie: t.cookie,
        Origin: `http://127.0.0.1:${t.server.port}`,
        "Content-Type": "application/json",
      },
    });
    req.on("error", () => undefined);
    req.end(JSON.stringify({ idea: "slow skill" }));
    await until(() => started);
    req.destroy();
    await until(() => aborted);
    expect(aborted).toBe(true);
  });
});

describe("POST /api/workspaces/:wid/skills", () => {
  it("saves a global skill under ~/.agents/skills, loads it and hides absolute paths", async () => {
    const { t, wid, home } = await start();
    const stream = openStream(t.server.port, t.cookie);
    const res = await t.api.post(`/api/workspaces/${wid}/skills`, {
      scope: "global",
      draft: draft(),
    });
    expect(res.status).toBe(201);
    const body = res.json<SkillCreateResult>();
    expect(body).toMatchObject({
      skill: { name: "budget-report", scope: "global", path: "~/.agents/skills/budget-report" },
      reloaded: true,
    });
    expect(res.text).not.toContain(home);
    expect(res.text).not.toContain(t.workspace);
    const dir = join(home, ".agents", "skills", "budget-report");
    expect(
      (await readFile(join(dir, "SKILL.md"), "utf8")).startsWith("---\nname: budget-report"),
    ).toBe(true);
    expect(existsSync(join(dir, "scripts", "summarize.py"))).toBe(true);
    await stream.next((e) => e.frame.t === "catalog_changed" && e.frame.scope === "skills");
    const skills = (await t.api.get(`/api/skills?workspace=${wid}`)).json<SkillInfo[]>();
    expect(skills.find((s) => s.displayId === "budget-report")).toMatchObject({
      effective: true,
      scope: "user",
    });
    stream.close();
  });

  it("saves a project skill under <workspace>/.agents/skills", async () => {
    const { t, wid } = await start();
    const res = await t.api.post(`/api/workspaces/${wid}/skills`, {
      scope: "project",
      draft: draft(),
    });
    expect(res.status).toBe(201);
    expect(res.json<SkillCreateResult>().skill.path).toBe(".agents/skills/budget-report");
    expect(res.text).not.toContain(t.workspace);
    expect(existsSync(join(t.workspace, ".agents", "skills", "budget-report", "SKILL.md"))).toBe(
      true,
    );
    const skills = (await t.api.get(`/api/skills?workspace=${wid}`)).json<SkillInfo[]>();
    expect(skills.find((s) => s.displayId === "budget-report")?.scope).toBe("project");
  });

  it("refuses the project scope in an untrusted workspace but still offers global", async () => {
    const { t, wid } = await start({ trusted: false });
    const refused = await t.api.post(`/api/workspaces/${wid}/skills`, {
      scope: "project",
      draft: draft(),
    });
    expect(refused.status).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: "not_manageable" } });
    expect(existsSync(join(t.workspace, ".agents"))).toBe(false);
    const global = await t.api.post(`/api/workspaces/${wid}/skills`, {
      scope: "global",
      draft: draft(),
    });
    expect(global.status).toBe(201);
  });

  it("conflicts on an existing skill unless overwrite is explicit", async () => {
    const { t, wid, home } = await start();
    const url = `/api/workspaces/${wid}/skills`;
    expect((await t.api.post(url, { scope: "global", draft: draft() })).status).toBe(201);
    const conflict = await t.api.post(url, {
      scope: "global",
      draft: draft({ body: "# New\n", files: [] }),
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: "skill_exists" } });
    expect(conflict.text).not.toContain(home);
    expect(await readFile(join(home, ".agents/skills/budget-report/SKILL.md"), "utf8")).toContain(
      "Budget report",
    );
    const replaced = await t.api.post(url, {
      scope: "global",
      draft: draft({ body: "# New\n", files: [] }),
      overwrite: true,
    });
    expect(replaced.status).toBe(201);
    expect(await readFile(join(home, ".agents/skills/budget-report/SKILL.md"), "utf8")).toContain(
      "# New",
    );
    expect(await readdir(join(home, ".agents/skills"))).toEqual(["budget-report"]);
  });

  it("rejects invalid drafts and bad bodies without writing anything", async () => {
    const { t, wid, home } = await start();
    const url = `/api/workspaces/${wid}/skills`;
    for (const body of [
      { scope: "global", draft: draft({ name: "../evil" }) },
      { scope: "global", draft: draft({ files: [{ path: "../x", content: "a" }] }) },
      { scope: "global", draft: draft({ name: "my-claude-skill" }) },
      { scope: "global", draft: draft({ body: "See `references/none.md`" }) },
      { scope: "somewhere", draft: draft() },
      { draft: draft() },
      { scope: "global" },
      { scope: "global", draft: draft(), overwrite: "yes" },
    ]) {
      const res = await t.api.post(url, body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });

  it("is unavailable under --read-only", async () => {
    const { t, wid } = await start({ readOnly: true });
    const res = await t.api.post(`/api/workspaces/${wid}/skills`, {
      scope: "global",
      draft: draft(),
    });
    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "capability_ceiling" } });
  });

  it("saves while a run is active but reports it is not live yet", async () => {
    const gated = gatedProvider();
    const home = await mkdtemp(join(tmpdir(), "alisio-skills-home-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    t = await startTestServer({
      provider: gated.provider,
      app: { trustProject: true, builtins: [] },
    });
    const wid = (await t.api.get("/api/workspaces")).json<Array<{ id: string }>>()[0]?.id ?? "";
    const session = await newSession(t);
    await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "go" });
    await gated.started;
    const res = await t.api.post(`/api/workspaces/${wid}/skills`, {
      scope: "global",
      draft: draft(),
    });
    expect(res.status).toBe(201);
    expect(res.json<SkillCreateResult>()).toMatchObject({
      reloaded: false,
      reason: expect.stringContaining("turn"),
    });
    expect(existsSync(join(home, ".agents/skills/budget-report/SKILL.md"))).toBe(true);
    gated.release();
    await settled(t, session.id);
    expect((await t.api.post(`/api/workspaces/${wid}/reload`, {})).status).toBe(200);
    const skills = (await t.api.get(`/api/skills?workspace=${wid}`)).json<SkillInfo[]>();
    expect(skills.some((s) => s.displayId === "budget-report" && s.effective)).toBe(true);
  });
});
