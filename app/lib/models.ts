// Shared by the model dropdown (client) and the chat route (server allowlist).
export type ChatModel = {
  id: string;
  name: string;
  // Server-side refusal fallback ("fallbacks": "default") - supported on Opus 5.5 and Sonnet 5.5,
  // not on Haiku 5.5.
  serverFallback: boolean;
};

export const MODELS: ChatModel[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", serverFallback: true },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", serverFallback: true },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", serverFallback: false },
];

export const DEFAULT_MODEL_ID = MODELS[0].id;
