import type { openDurableEtherMemories } from "../src/core/DurableEtherMemories.js";
export const producerArchiveSha256: string;
export function verifyProducerArchive(bytes: Uint8Array): void;
export function prepareProducer(root: string): Promise<{
  archive: string;
  openProducer: typeof openDurableEtherMemories;
  cleanup: () => Promise<void>;
}>;
