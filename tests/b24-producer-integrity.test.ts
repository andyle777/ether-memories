import { expect, it } from "vitest";
it("rejects an archive that does not match the released producer pin", async () => {
  const { verifyProducerArchive } = await import("../scripts/b24-producer.mjs");
  expect(() => verifyProducerArchive(Buffer.from("not the release"))).toThrow(/integrity/i);
});
