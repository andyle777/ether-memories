import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EtherMemoriesCore } from "../src/core/EtherMemories.js";

afterEach(() => vi.restoreAllMocks());

describe("legacy snapshot directory handle cleanup", () => {
  it.each(["success", "sync failure", "close failure", "open failure"])(
    "preserves best-effort directory sync and closes acquired handles on %s", async mode => {
      const directory = await fs.mkdtemp(join(tmpdir(), "ether-json-handle-"));
      const path = join(directory, "snapshot.json");
      const originalOpen = fs.open.bind(fs);
      const sync = vi.fn(async () => { if (mode === "sync failure") throw new Error("unsupported directory sync"); });
      const close = vi.fn(async () => { if (mode === "close failure") throw new Error("directory close rejected"); });
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (args[0] !== directory) return originalOpen(...args);
        if (mode === "open failure") throw new Error("unsupported directory open");
        return { sync, close } as unknown as Awaited<ReturnType<typeof fs.open>>;
      });
      try {
        const source = new EtherMemoriesCore({ userId: "handle-test", storagePath: path });
        expect(source.addMemory({ content: "snapshot survives best-effort barrier failure" }).ok).toBe(true);
        expect((await source.save()).ok).toBe(true);
        expect(sync).toHaveBeenCalledTimes(mode === "open failure" ? 0 : 1);
        expect(close).toHaveBeenCalledTimes(mode === "open failure" ? 0 : 1);
        const loaded = new EtherMemoriesCore({ userId: "handle-test", storagePath: path });
        expect((await loaded.load()).ok).toBe(true);
        expect(loaded.exportData()).toEqual(source.exportData());
        expect(await fs.readdir(directory)).toEqual(["snapshot.json"]);
      } finally {
        vi.restoreAllMocks();
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  );
});
