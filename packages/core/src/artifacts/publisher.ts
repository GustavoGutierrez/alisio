/**
 * The `ToolContext.artifacts` of one tool call: binds the artifact store to the calling session
 * (and its root), run and call, and announces every publication (`artifact_published`).
 */
import type { CoreArtifactPublisher, PublishedArtifactInfo } from "../core/contracts.ts";
import type { ArtifactOwner, ArtifactStore, PublishedArtifact } from "./store.ts";

export function createArtifactPublisher(
  store: ArtifactStore,
  owner: ArtifactOwner,
  announce: (published: PublishedArtifactInfo) => void,
): CoreArtifactPublisher {
  const done = (published: PublishedArtifact, executionId?: string): PublishedArtifactInfo => {
    const info = { ...published, ...(executionId ? { executionId } : {}) };
    announce(info);
    return info;
  };
  return {
    async publish(input) {
      return done(await store.publish(input, owner)).artifact;
    },
    async publishText(input) {
      return done(await store.publishText(input, owner)).artifact;
    },
    async publishTextDetailed(input) {
      return done(await store.publishText(input, owner));
    },
    async publishOutputs(staging, options) {
      const published = await store.publishOutputs(
        staging,
        {
          ...owner,
          executionId: options.executionId,
          ...(options.partial ? { partial: true } : {}),
          ...(options.provenance
            ? { provenance: { ...owner.provenance, ...options.provenance } }
            : {}),
        },
        options.title ? { title: options.title } : {},
      );
      return published.map((p) => done(p, options.executionId));
    },
  };
}
