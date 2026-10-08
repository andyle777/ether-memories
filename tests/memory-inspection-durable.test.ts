import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { EtherMemoriesCore } from "../src/index.js";
import { openDurableEtherMemoriesInternal } from "../src/core/DurableEtherMemories.js";
import { nodeWalIO } from "../src/persistence/walIO.js";
import { value } from "./helpers/persistence.js";
import { bootstrap } from "./helpers/recovery.js";

const cleanup: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of cleanup.splice(0)) await fs.rm(path, { recursive: true, force: true });
});
const hashes = async (directory: string): Promise<Record<string, string>> => {
  const result: Record<string, string> = {};
  const visit = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) await visit(path);
      else result[path.slice(directory.length)] = createHash("sha256").update(await fs.readFile(path)).digest("hex");
    }
  };
  await visit(directory); return result;
};

describe("T2 durable logical reads", { timeout: 120000 }, () => {
  it("matches Core, performs no directory/WAL I/O and preserves every store byte and tip", async () => {
    const s = await bootstrap(); cleanup.push(s.parent);
    const io = { ...s.io }, files = { ...nodeWalIO };
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io, files }));
    const snapshot = value(runtime.exportData());
    const c = new EtherMemoriesCore({ userId: snapshot.identity.userId }); value(c.importData(snapshot));
    const tip = value(runtime.tip), before = await hashes(s.directory);
    const spies = [];
    for (const owner of [io, files]) {
      for (const key of Object.keys(owner)) if (typeof (owner as Record<string, unknown>)[key] === "function") {
        spies.push(vi.spyOn(owner as never, key as never).mockImplementation(() => { throw Error(`unexpected I/O: ${key}`); }));
      }
    }
    const clock = vi.spyOn(Date, "now").mockReturnValue(1893456000000);
    const health = runtime.inspectMemoryHealth(); expect(clock).toHaveBeenCalledTimes(1); clock.mockClear();
    expect(health).toEqual(c.inspectMemoryHealth({ asOf: 1893456000000 }));
    for (const n of snapshot.memoryNotes) {
      expect(runtime.explainMemory(n.id, { asOf: 1893456000000 })).toEqual(c.explainMemory(n.id, { asOf: 1893456000000 }));
    }
    expect(clock).not.toHaveBeenCalled();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(value(runtime.tip)).toEqual(tip); expect(value(runtime.exportData())).toEqual(snapshot);
    expect(await hashes(s.directory)).toEqual(before);
    const noteId = snapshot.memoryNotes[0].id;
    const report = value(runtime.explainMemory(noteId, { asOf: 100 })); report.note.tags.push("caller");
    expect(value(runtime.explainMemory(noteId, { asOf: 100 })).note.tags).not.toContain("caller");
    value(await runtime.close());
    for (const id of [noteId, "", "unknown"]) expect(runtime.explainMemory(id, { asOf: NaN })).toMatchObject({ ok: false, error: { code: "CLOSED" } });
    expect(runtime.inspectMemoryHealth({ asOf: NaN })).toMatchObject({ ok: false, error: { code: "CLOSED" } });
  });

  it("gives recovery-required precedence and resumes inspection only after explicit recovery", async () => {
    const s = await bootstrap(); cleanup.push(s.parent);
    let armed = false;
    const files = { ...nodeWalIO, open: async (path: string, create: boolean) => {
      const handle = await nodeWalIO.open(path, create);
      return { ...handle, sync: async () => { await handle.sync(); if (armed) { armed = false; throw Error("lost sync ACK"); } } };
    } };
    const runtime = value(await openDurableEtherMemoriesInternal({ userId: s.snapshot.identity.userId, directory: s.directory, openMode: "existing" }, { io: s.io, files }));
    armed = true;
    expect((await runtime.addMemory({ content: "ambiguous" }, "t2-ambiguity")).ok).toBe(false);
    expect(runtime.state).toBe("recovery-required");
    const clock = vi.spyOn(Date, "now");
    for (const id of [s.snapshot.memoryNotes[0].id, "", "unknown"]) expect(runtime.explainMemory(id, { asOf: NaN })).toMatchObject({ ok: false, error: { code: "RECOVERY_REQUIRED" } });
    expect(runtime.inspectMemoryHealth({ asOf: NaN })).toMatchObject({ ok: false, error: { code: "RECOVERY_REQUIRED" } });
    expect(runtime.inspectMemoryHealth()).toMatchObject({ ok: false, error: { code: "RECOVERY_REQUIRED" } });
    expect(clock).not.toHaveBeenCalled(); clock.mockRestore();
    value(await runtime.recover());
    expect(runtime.inspectMemoryHealth({ asOf: 100 }).ok).toBe(true);
    value(await runtime.close());
  });
});
