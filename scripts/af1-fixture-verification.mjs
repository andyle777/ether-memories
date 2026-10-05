import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Canonical committed-blob (LF) pins mirrored from release-integrity.test.ts.
// Checkout line-ending conversion must not change frozen fixture identity.
const FIXTURE_HASHES = {
  "tests/fixtures/persistence-wire-v1.json": "ecc0d9b2276c9569bec4a3a139fb0ea3da12186459330c292dfb9c04255524af",
  "tests/fixtures/portable-record-v1.json": "97626d9819a977b0d73687ee9a57ba7dfbc046c14476afad1ecc0faeeb951e5b",
  "tests/fixtures/retrieval-golden-v1.json": "9eafc0a7d772ca1d7385bd1e3cc548245a2d885f6d322f3b982a18bcd9f6cc52",
  "tests/fixtures/store-v0.3.json": "c2ba81d5952550a696e295181a7e802c440728977ce55a17f39291c2cd428a15",
  "tests/fixtures/wal-wire-v1.json": "04c980368c39c9506bd40d314ee1ef1f590ab169a09cff022b0f4a115133050c"
};

export function verifyFrozenFixtures(readText = file => readFileSync(file, "utf8")) {
  return Object.entries(FIXTURE_HASHES).map(([fixture, expected]) => {
    const sha256 = createHash("sha256").update(readText(fixture).replace(/\r\n/g, "\n"), "utf8").digest("hex");
    return { fixture, sha256, pass: sha256 === expected };
  });
}
