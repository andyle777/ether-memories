import { readFileSync, writeFileSync } from "node:fs";

const changed = [];
const read = path => readFileSync(path, "utf8");
const write = (path, text) => { writeFileSync(path, text); changed.push(path); };
const once = (path, before, after, label = before.slice(0, 50)) => {
  const text = read(path);
  const first = text.indexOf(before);
  if (first < 0 || text.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${path}: expected exactly one match for ${label}`);
  }
  write(path, text.slice(0, first) + after + text.slice(first + before.length));
};
const regexOnce = (path, regex, replacer, label) => {
  const text = read(path);
  const matches = [...text.matchAll(new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g"))];
  if (matches.length !== 1) throw new Error(`${path}: expected one ${label}, found ${matches.length}`);
  write(path, text.replace(regex, replacer));
};
const allCount = (path, before, after, expected, label) => {
  const text = read(path);
  const count = text.split(before).length - 1;
  if (count !== expected) throw new Error(`${path}: expected ${expected} ${label}, found ${count}`);
  write(path, text.split(before).join(after));
};

// 1) One capability-aware DirectoryIO boundary. Strict nodeDirectoryIO remains strict.
{
  const p = "src/persistence/directoryIO.ts";
  once(p,
`export interface DirectoryIO {\n  kind(path: string): Promise<"missing" | "file" | "directory">;`,
`export type DirectoryDurabilityGuarantee = "strict" | "recoverable";\nexport type DirectoryActivation = "atomic" | "process-recoverable";\nexport type DurabilityAcknowledgement = "confirmed" | "process-recoverable";\n\nexport interface DirectoryIO {\n  /** Missing means legacy/internal test backend and defaults to strict. */\n  readonly guarantee?: DirectoryDurabilityGuarantee;\n  kind(path: string): Promise<"missing" | "file" | "directory">;`, "DirectoryIO guarantee");
  once(p,
`  activateFile(candidate: string, destination: string): Promise<"atomic">;`,
`  activateFile(candidate: string, destination: string): Promise<DirectoryActivation>;`, "activation type");
  once(p,
`}\n\nexport const nodeDirectoryIO: DirectoryIO = {`,
`}\n\nexport const directoryGuarantee = (io: DirectoryIO): DirectoryDurabilityGuarantee => io.guarantee ?? "strict";\nexport const durabilityAcknowledgement = (io: DirectoryIO): DurabilityAcknowledgement =>\n  directoryGuarantee(io) === "strict" ? "confirmed" : "process-recoverable";\nexport const activationMatchesGuarantee = (io: DirectoryIO, activation: DirectoryActivation): boolean =>\n  directoryGuarantee(io) === "strict" ? activation === "atomic" : activation === "process-recoverable";\n\nexport const nodeDirectoryIO: DirectoryIO = {\n  guarantee: "strict",`, "DirectoryIO helpers");
  const text = read(p);
  if (!text.trimEnd().endsWith("};")) throw new Error(`${p}: unexpected file tail`);
  const appendix = `\n\nconst assertWindowsRecoverablePath = (path: string): void => {\n  // Node 22/libuv 1.51 aborts the process on U+10FFFF in a Windows path.\n  if (path.includes(String.fromCodePoint(0x10ffff))) {\n    throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "This Windows path contains an unsupported code point.");\n  }\n  // v0.7 recoverable certification is local filesystem only; UNC/device namespace is out of scope.\n  if (path.startsWith("\\\\")) {\n    throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "Windows recoverable mode requires a local filesystem path.");\n  }\n};\n\n/**\n * Windows process-recoverable backend. Regular files retain their file-sync\n * barriers. Directory sync is deliberately NOT claimed: native Windows Node\n * 22/24 returns EPERM for the strict directory-fsync path. Replacement rename\n * is therefore acknowledged only as process-recoverable and every authoritative\n * caller still rereads/verifies state. This does not claim power-loss durability.\n */\nexport const windowsRecoverableDirectoryIO: DirectoryIO = {\n  guarantee: "recoverable",\n  async kind(path) { assertWindowsRecoverablePath(path); return nodeDirectoryIO.kind(path); },\n  async readBounded(path, maxBytes) { assertWindowsRecoverablePath(path); return nodeDirectoryIO.readBounded(path, maxBytes); },\n  async readNames(path, visit) { assertWindowsRecoverablePath(path); return nodeDirectoryIO.readNames(path, visit); },\n  async mkdirExclusive(path) { assertWindowsRecoverablePath(path); return nodeDirectoryIO.mkdirExclusive(path); },\n  async writeExclusive(path, bytes) { assertWindowsRecoverablePath(path); return nodeDirectoryIO.writeExclusive(path, bytes); },\n  async syncDirectory(path) {\n    assertWindowsRecoverablePath(path);\n    if (await nodeDirectoryIO.kind(path) !== "directory") {\n      throw new DirectoryIoError("RECOVERY_REQUIRED", "Expected persistence directory is unavailable.");\n    }\n  },\n  async activateFile(candidate, destination) {\n    assertWindowsRecoverablePath(candidate);\n    assertWindowsRecoverablePath(destination);\n    await fs.rename(candidate, destination);\n    return "process-recoverable";\n  },\n  async removeOwnedFile(path) { assertWindowsRecoverablePath(path); return nodeDirectoryIO.removeOwnedFile(path); }\n};\n`;
  write(p, text.trimEnd() + appendix);
}

// 2) WAL acknowledgment becomes capability-aware; wire bytes and transaction semantics are untouched.
{
  const p = "src/persistence/FsWalStore.ts";
  once(p,
`import { DirectoryIoError, nodeDirectoryIO, type DirectoryIO } from "./directoryIO.js";`,
`import { DirectoryIoError, durabilityAcknowledgement, nodeDirectoryIO, type DirectoryIO, type DurabilityAcknowledgement } from "./directoryIO.js";`, "FsWalStore DirectoryIO import");
  once(p, `  readonly durability: "confirmed";`, `  readonly durability: DurabilityAcknowledgement;`, "CommitReceipt durability");
  once(p, `  durability: "unconfirmed" | "confirmed";`, `  durability: "unconfirmed" | DurabilityAcknowledgement;`, "attempt durability");
  allCount(p, `durability: "confirmed"`, `durability: durabilityAcknowledgement(this.directoryIO)`, 2, "receipt confirmation literals");
  once(p, `state.durability = "confirmed";`, `state.durability = durabilityAcknowledgement(this.directoryIO);`, "attempt confirmation assignment");
}

// 3) HEAD activation keeps strict values intact and returns weaker internal values in recoverable mode.
{
  const p = "src/persistence/FsDurableStore.ts";
  once(p,
`import { DirectoryIoError, nodeDirectoryIO, type DirectoryIO } from "./directoryIO.js";`,
`import { activationMatchesGuarantee, directoryGuarantee, DirectoryIoError, durabilityAcknowledgement, nodeDirectoryIO, type DirectoryIO, type DirectoryActivation, type DurabilityAcknowledgement } from "./directoryIO.js";`, "FsDurableStore DirectoryIO import");
  regexOnce(p,
/export interface HeadActivationReceipt \{\s*readonly head: PersistedStoreHead;\s*readonly activation: "atomic";\s*readonly durability: "confirmed";\s*\}/m,
`export interface HeadActivationReceipt {\n  readonly head: PersistedStoreHead;\n  readonly activation: DirectoryActivation;\n  readonly durability: DurabilityAcknowledgement;\n}`,
"HeadActivationReceipt");
  once(p,
`if (activated !== "atomic") throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "Backend did not confirm atomic activation.");`,
`if (!activationMatchesGuarantee(this.io, activated)) throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "Backend activation did not match the selected durability guarantee.");`, "HEAD activation gate");
  allCount(p,
`activation: "atomic", durability: "confirmed"`,
`activation: directoryGuarantee(this.io) === "strict" ? "atomic" : "process-recoverable", durability: durabilityAcknowledgement(this.io)`,
1, "HEAD receipt literals");
}

// 4) Historical receipt ledger proves identity/effects, not original durability profile.
{
  const p = "src/persistence/productionOperations.ts";
  once(p,
`import { nodeDirectoryIO, type DirectoryIO } from "./directoryIO.js";`,
`import { durabilityAcknowledgement, nodeDirectoryIO, type DirectoryIO } from "./directoryIO.js";`, "productionOperations DirectoryIO import");
  once(p,
`        durability: "confirmed"\n      };`,
`        // Current-invocation acknowledgement after authoritative revalidation; receipt ledger v1 does not encode original profile.\n        durability: durabilityAcknowledgement(this.io)\n      };`, "historical receipt acknowledgement");
}

// 5) Immutable payload install accepts only activation matching the selected capability.
{
  const p = "src/persistence/payloadObjects.ts";
  once(p,
`import { DirectoryIoError, type DirectoryIO } from "./directoryIO.js";`,
`import { activationMatchesGuarantee, DirectoryIoError, type DirectoryIO } from "./directoryIO.js";`, "payload DirectoryIO import");
  once(p,
`if (await this.io.activateFile(temporary, destination) !== "atomic") throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "Object install was not atomic.");`,
`if (!activationMatchesGuarantee(this.io, await this.io.activateFile(temporary, destination))) throw new DirectoryIoError("DURABILITY_UNAVAILABLE", "Object activation did not match the selected durability guarantee.");`, "payload activation gate");
}

// 6) Rotation P6 authority switch keeps its verification but accepts the selected capability label.
{
  const p = "src/persistence/checkpointRotation.ts";
  once(p,
`import { nodeDirectoryIO, DirectoryIoError, type DirectoryIO } from "./directoryIO.js";`,
`import { activationMatchesGuarantee, nodeDirectoryIO, DirectoryIoError, type DirectoryIO } from "./directoryIO.js";`, "rotation DirectoryIO import");
  once(p,
`      if (activated !== "atomic") {\n        return err("DURABILITY_UNAVAILABLE", "Backend did not confirm atomic HEAD activation.", { activationState: "pre-activation" });\n      }`,
`      if (!activationMatchesGuarantee(io, activated)) {\n        return err("DURABILITY_UNAVAILABLE", "Backend HEAD activation did not match the selected durability guarantee.", { activationState: "pre-activation" });\n      }`, "rotation HEAD gate");
}

// 7) Public capability selection happens exactly once when opening the runtime.
{
  const p = "src/core/DurableEtherMemories.ts";
  once(p,
`import { DirectoryIoError, nodeDirectoryIO, type DirectoryIO } from "../persistence/directoryIO.js";`,
`import { DirectoryIoError, nodeDirectoryIO, windowsRecoverableDirectoryIO, type DirectoryIO } from "../persistence/directoryIO.js";`, "runtime DirectoryIO import");
  once(p,
`  readonly openMode?: "auto" | "create" | "existing";\n}`,
`  readonly openMode?: "auto" | "create" | "existing";\n  /** Strict is the default. Recoverable is a weaker, explicit process-failure contract on supported Windows local filesystems. */\n  readonly durabilityGuarantee?: "strict" | "recoverable";\n}`,
"public durability option");
  once(p,
`/** Public durable factory: only supported user configuration; no injection points. */\nexport const openDurableEtherMemories = (options: DurableEtherMemoriesOptions): Promise<Result<DurableEtherMemories>> =>\n  withFacade(DurableRuntime.open(options));\n\n/** Internal test factory with protocol-testing dependency injection; never exported from the package root. */\nexport const openDurableEtherMemoriesInternal = (options: DurableEtherMemoriesOptions,\n  dependencies: DurableDependencies = {}): Promise<Result<DurableEtherMemories>> =>\n  withFacade(DurableRuntime.open(options, dependencies.io ?? nodeDirectoryIO, dependencies.files ?? nodeWalIO,\n    dependencies.indexDiskBytes ?? DEFAULT_MAX_INDEX_BYTES, dependencies.maxActiveWalBytes ?? MAX_ACTIVE_WAL_BYTES,\n    dependencies.gcInstrumentation ?? { at: async () => undefined }));`,
`const selectDirectoryIO = (options: DurableEtherMemoriesOptions): Result<DirectoryIO> => {\n  const requested = options.durabilityGuarantee ?? "strict";\n  if (requested !== "strict" && requested !== "recoverable") return err("INVALID_INPUT", "Invalid durability guarantee.");\n  if (requested === "recoverable" && process.platform === "win32") return ok(windowsRecoverableDirectoryIO);\n  // On platforms where the frozen strict backend is available, strict exceeds a recoverable request.\n  return ok(nodeDirectoryIO);\n};\n\n/** Public durable factory: only supported user configuration; no injection points. */\nexport const openDurableEtherMemories = (options: DurableEtherMemoriesOptions): Promise<Result<DurableEtherMemories>> => {\n  const io = selectDirectoryIO(options);\n  if (!io.ok) return Promise.resolve(err(io.error.code, io.error.message, io.error.details));\n  return withFacade(DurableRuntime.open(options, io.value));\n};\n\n/** Internal test factory with protocol-testing dependency injection; never exported from the package root. */\nexport const openDurableEtherMemoriesInternal = (options: DurableEtherMemoriesOptions,\n  dependencies: DurableDependencies = {}): Promise<Result<DurableEtherMemories>> => {\n  const selected = dependencies.io ? ok(dependencies.io) : selectDirectoryIO(options);\n  if (!selected.ok) return Promise.resolve(err(selected.error.code, selected.error.message, selected.error.details));\n  return withFacade(DurableRuntime.open(options, selected.value, dependencies.files ?? nodeWalIO,\n    dependencies.indexDiskBytes ?? DEFAULT_MAX_INDEX_BYTES, dependencies.maxActiveWalBytes ?? MAX_ACTIVE_WAL_BYTES,\n    dependencies.gcInstrumentation ?? { at: async () => undefined }));\n};`,
"runtime public/internal factories");
}

console.log("Round 11 T5 codemod applied:", [...new Set(changed)].sort());
