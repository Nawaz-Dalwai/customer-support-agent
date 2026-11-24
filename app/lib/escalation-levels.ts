// Answer-or-escalate policy: how readily the assistant hands a conversation to a human agent.
// Shared by the chat's policy selector (client) and the chat route (server validation + prompt).
export const ESCALATION_LEVELS = {
  cautious: {
    name: "Cautious",
    summary: "Hands off whenever an answer is uncertain or money, access or security is involved",
  },
  balanced: {
    name: "Balanced",
    summary: "Answers what the help articles cover and hands off the rest",
  },
  resolve_first: {
    name: "Resolve-first",
    summary: "Tries to answer; hands off only when a person is asked for or staff must decide",
  },
} as const;

export type EscalationLevel = keyof typeof ESCALATION_LEVELS;
export const ESCALATION_LEVEL_IDS = Object.keys(ESCALATION_LEVELS) as [EscalationLevel, ...EscalationLevel[]];
export const DEFAULT_ESCALATION_LEVEL: EscalationLevel = "balanced";
