import type { UiBlock } from "@alisio/sdk";
import { ArtifactCard } from "../../components/artifacts/ArtifactCard.tsx";

/** The compact card repeated inside an expanded tool row (`artifact` UI blocks). */
export default function ArtifactView({ block }: { block: UiBlock }) {
  if (block.kind !== "artifact") return null;
  return <ArtifactCard artifact={block.artifact} compact />;
}
