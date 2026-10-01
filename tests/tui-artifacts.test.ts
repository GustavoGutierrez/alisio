import type { ArtifactRef } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  artifactActions,
  artifactLines,
  artifactRow,
  capabilityApprovalTitle,
  detailRows,
  displayPath,
  installApprovalDetail,
  installApprovalTitle,
  matchArtifact,
  permissionRow,
} from "../packages/cli/src/tui/artifacts.ts";
import { renderArtifactBlock } from "../packages/cli/src/tui/components.ts";

const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const artifact = (patch: Partial<ArtifactRef> = {}): ArtifactRef => ({
  id: "art_01",
  sessionId: "s",
  title: "Sales dashboard",
  fileName: "sales-dashboard.html",
  kind: "dashboard",
  mimeType: "text/html; charset=utf-8",
  bytes: 48 * 1024,
  fileCount: 1,
  previewable: true,
  createdAt: 1_000_000,
  status: "ready",
  ...patch,
});

describe("artifact announcement (§16.1)", () => {
  it("shows icon, kind, name, size and the local path with ~ for home", () => {
    const lines = artifactLines(artifact(), {
      path: "/home/ana/.local/state/alisio/artifacts/w/s/x/files/sales-dashboard.html",
      width: 120,
      unicode: true,
      home: "/home/ana",
    }).map(strip);
    expect(lines[0]).toBe("  ▤ Dashboard  sales-dashboard.html  48 KB");
    expect(lines[1]).toBe("    ~/.local/state/alisio/artifacts/w/s/x/files/sales-dashboard.html");
  });

  it("uses ASCII icons without Unicode and cuts long paths in the middle", () => {
    const [first, second] = artifactLines(artifact({ kind: "archive", fileName: "a.zip" }), {
      path: `/data/${"x".repeat(200)}/files/a.zip`,
      width: 40,
      unicode: false,
      home: "/home/ana",
    }).map(strip);
    expect(first).toMatch(/^ {2}\[Z\] Archive {2}a\.zip/);
    expect(second?.length).toBeLessThanOrEqual(40);
    expect(second).toContain("…");
    expect(second?.trim().startsWith("/data/")).toBe(true);
    expect(second?.endsWith("files/a.zip")).toBe(true);
    expect(displayPath("C:\\Users\\ana\\x.md", "C:\\Users\\ana", 80)).toBe("~\\x.md");
  });

  it("marks partial and deleted artifacts and drops the path when not ready", () => {
    expect(
      strip(
        artifactLines(artifact({ partial: true }), { width: 80, unicode: true, home: "" })[0] ?? "",
      ),
    ).toContain("(partial)");
    const deleted = artifactLines(artifact({ status: "deleted" }), {
      path: "/x",
      width: 80,
      unicode: true,
      home: "",
    });
    expect(deleted).toHaveLength(1);
    expect(strip(deleted[0] ?? "")).toContain("(deleted)");
  });

  it("renders the artifact UiBlock through the TUI renderer", () => {
    const text = renderArtifactBlock(
      { kind: "artifact", artifact: artifact() },
      80,
      true,
      "/tmp/a.html",
    )
      .map(strip)
      .join("\n");
    expect(text).toContain("Dashboard  sales-dashboard.html  48 KB");
    expect(text).toContain("/tmp/a.html");
  });
});

describe("/artifacts picker and actions (§16.2)", () => {
  it("formats rows, filters by name, title and kind", () => {
    expect(artifactRow(artifact(), 1_000_000 + 4 * 60_000)).toBe(
      "Dashboard    sales-dashboard.html  48 KB  4 min",
    );
    expect(matchArtifact(artifact(), "sales")).toBe(true);
    expect(matchArtifact(artifact(), "DASH")).toBe(true);
    expect(matchArtifact(artifact(), "sales dashboard")).toBe(true);
    expect(matchArtifact(artifact(), "pdf")).toBe(false);
  });

  it("offers open, copy, reveal and delete for ready artifacts only", () => {
    // A dashboard never previews in the terminal: only the system app opens it.
    expect(artifactActions(artifact()).map((a) => a.label)).toEqual([
      "Open with default app",
      "Copy path",
      "Reveal in folder",
      "Copy to workspace…",
      "Details",
      "Delete",
    ]);
    expect(artifactActions(artifact({ status: "deleted" }))).toEqual([]);
    // Text-like artifacts preview here; python_run outputs reveal their sources.
    const md = artifact({ fileName: "r.md", kind: "document" });
    expect(artifactActions(md, { sources: true }).map((a) => a.value)).toEqual([
      "preview",
      "open",
      "copy",
      "reveal",
      "export",
      "sources",
      "details",
      "delete",
    ]);
    // --read-only hides "Copy to workspace…" (the write gate cannot be passed).
    expect(artifactActions(md, { readOnly: true }).map((a) => a.value)).not.toContain("export");
  });
});

describe("Rerun and Expired (§19, phase 4)", () => {
  it("offers Rerun for python_run outputs when python_run is available, after Details", () => {
    const md = artifact({ fileName: "r.md", kind: "document" });
    const values = artifactActions(md, { sources: true, rerun: true }).map((a) => a.value);
    expect(values).toEqual([
      "preview",
      "open",
      "copy",
      "reveal",
      "export",
      "sources",
      "details",
      "rerun",
      "delete",
    ]);
    expect(artifactActions(md, { rerun: false }).map((a) => a.value)).not.toContain("rerun");
  });

  it("an expired artifact lists as Expired and keeps only Details and Rerun", () => {
    const expired = artifact({ status: "expired" });
    expect(artifactRow(expired, 1_000_000 + 3_600_000)).toMatch(/ {2}Expired$/);
    expect(artifactActions(expired, { rerun: true }).map((a) => a.value)).toEqual([
      "details",
      "rerun",
    ]);
    expect(artifactActions(expired).map((a) => a.value)).toEqual(["details"]);
    expect(artifactRow(artifact(), 1_000_000)).not.toMatch(/Expired/);
  });

  it("Details names the original execution of a rerun and the status of an expired file", () => {
    const rows = Object.fromEntries(
      detailRows(artifact({ status: "expired" }), {
        executionId: "exec_2",
        rerunOf: "exec_1",
        runtime: {
          mode: "oci",
          engine: "podman",
          image: `python@sha256:${"c".repeat(64)}`,
        },
      }),
    );
    expect(rows["Rerun of"]).toBe("exec_1");
    expect(rows.Status).toMatch(/Expired/);
    expect(rows.Runtime).toBe(`oci · podman · python@sha256:${"c".repeat(12)}…`);
  });
});

describe("analysis.install approval (phase 4)", () => {
  const install = {
    extras: "analysis" as const,
    packages: ["pandas", "numpy", "matplotlib"],
    packageCount: 32,
    estimatedBytes: 75 * 1024 * 1024,
    network: true as const,
  };
  it("shows the packages, the download estimate and that it needs the network", () => {
    expect(installApprovalTitle(install)).toBe(
      "Install Python packages (analysis; needs network)?",
    );
    const detail = installApprovalDetail(install);
    expect(detail).toContain("pandas, numpy, matplotlib");
    expect(detail).toContain("32 pinned wheels");
    expect(detail).toContain("about 75.0 MB");
    expect(detail).toMatch(/needs network access/);
    expect(detail).toMatch(/never remembered/);
    expect(detail).toMatch(/hash-verified/);
  });
});

describe("Details (§19)", () => {
  it("lists provenance without paths or code, skipping what is unknown", () => {
    const rows = detailRows(artifact({ partial: true }), {
      runtime: { mode: "managed", python: "3.12.6", extras: [] },
      inputs: [{ name: "sales.csv", sha256: "abcdef0123456789ffff" }],
      executionId: "exec_1",
      scriptSha256: "0".repeat(64),
    });
    const byLabel = Object.fromEntries(rows);
    expect(byLabel.Runtime).toBe("managed · Python 3.12.6");
    expect(byLabel.Inputs).toBe("sales.csv (abcdef012345)");
    expect(byLabel.Execution).toBe("exec_1");
    expect(byLabel.Partial).toBe("yes");
    expect(byLabel.Model).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain("0000000000");
  });
});

describe("approvals and /permissions (§16.5)", () => {
  it("titles the capability approval with the runtime and its isolation", () => {
    expect(capabilityApprovalTitle("managed")).toBe(
      "Run Python analysis (managed · not sandboxed)?",
    );
    expect(capabilityApprovalTitle("oci")).toBe("Run Python analysis (container · no network)?");
  });

  it("describes a saved grant", () => {
    const at = new Date(2026, 0, 1, 10, 42).getTime();
    expect(
      permissionRow({
        id: "g",
        capability: "analysis.run",
        sessionId: "s",
        scope: "session",
        decision: "allow",
        source: "web",
        createdAt: at,
      }),
    ).toBe("Python analysis · allowed for this session · since 10:42 (web)");
  });
});
