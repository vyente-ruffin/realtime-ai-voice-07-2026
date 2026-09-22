// Native Hindsight summaries, refreshed in the background, never per spoken turn.
const evidence = "Use only supported personal facts. Newer explicit corrections replace older facts. Questions, requests, and assistant guesses are not facts or completed actions. Omit unknown details. Write short factual bullets, not instructions. Do not copy operating policies or troubleshooting logs.";
export const voiceMemoryModels = [
  {
    id: "jarvis-voice-profile",
    name: "Voice: personal facts and relationships",
    source_query: `Who is this user? Include their name and preferred name first, important people and relationships, home, occupation, and enduring personal interests when known. Exclude project status and communication preferences. Keep under 1200 characters. ${evidence}`,
    max_tokens: 256,
  },
  {
    id: "jarvis-voice-preferences",
    name: "Voice: everyday preferences",
    source_query: `What are this user's established everyday preferences, habits, likes, dislikes, and communication preferences? Prioritize facts a personal assistant would use in ordinary conversation. Exclude software operating procedures, approval rules, task logs, and project status. Keep under 1200 characters. ${evidence}`,
    max_tokens: 256,
  },
  {
    id: "jarvis-voice-current",
    name: "Voice: current priorities and recent decisions",
    source_query: `What are this user's most important current priorities, active personal commitments, and recent explicit decisions or corrections? Select at most five useful items, prefer the latest evidence, include relevant dates, and drop superseded or completed items. A remembered project status is a dated report, not a fresh service check. Exclude detailed troubleshooting histories and lists of every project. Keep under 1500 characters. ${evidence}`,
    max_tokens: 384,
  },
].map((model) => ({
  ...model,
  // Full regeneration bounds size; repeated delta edits can grow indefinitely.
  trigger: { mode: "full", refresh_after_consolidation: true, min_refresh_interval_seconds: 300 },
}));
export const defaultMemoryModelIds = voiceMemoryModels.map((model) => model.id);
export const maxMemoryCharacters = 2400;
