import { describe, expect, it } from "vitest";
import { hostDependencyViolation } from "../scripts/pack-guards.ts";

describe("pack:check D2 guard (SE-AC-16)", () => {
  it("fails naming the package when a host package ships onnxruntime-node", () => {
    const message = hostDependencyViolation("@alisio/core", {
      dependencies: { zod: "1.0.0", "onnxruntime-node": "1.2.3" },
    });
    expect(message).toContain("@alisio/core");
    expect(message).toContain("onnxruntime-node");
  });

  it.each(["@lancedb/lancedb", "onnxruntime-web", "@huggingface/transformers"])(
    "rejects %s",
    (dep) => {
      expect(hostDependencyViolation("@alisio/server", { dependencies: { [dep]: "1" } })).toContain(
        dep,
      );
    },
  );

  it("accepts clean manifests and ignores non-runtime dependency fields", () => {
    expect(hostDependencyViolation("@alisio/sdk", {})).toBeUndefined();
    expect(
      hostDependencyViolation("@alisio/core", {
        dependencies: { zod: "1", "@huggingface/hub": "1" },
        devDependencies: { "onnxruntime-node": "1" },
      } as never),
    ).toBeUndefined();
  });
});
