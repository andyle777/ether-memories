import { EtherMemoriesCore, toAgentToolResult, toRlmEnv } from "../src/index.js";

const ether = new EtherMemoriesCore({
  userId: "demo-user",
  displayName: "Demo"
});

ether.addMemory({
  content: "Ether Memories has three foundations: Notes, Diary, and Mind Graph.",
  tags: ["ether", "architecture"]
});

ether.addDiaryEntry({
  content: "Built the first AI-ready transport layer.",
  tags: ["milestone"]
});

const context = ether.buildMemoryContext({
  purpose: "agent_tool",
  query: {
    text: "three foundations",
    budget: { maxNotes: 8, maxDiary: 2, maxNodes: 16, maxEdges: 16, maxChars: 8000 }
  }
});

if (context.ok) {
  console.log(toAgentToolResult(context.value));
  console.log(toRlmEnv(context.value).handles);
}
