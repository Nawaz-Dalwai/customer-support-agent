// List prices used for the estimated cost per reply on /insights. Estimates only: they ignore
// prompt caching and any server-side refusal fallback, so the real bill can differ.
// Claude: USD per million tokens, Claude API list prices for prompts under 100K tokens (checked 2026-11-24).
export const CLAUDE_PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};
// Bedrock Managed Knowledge Base search: $1 per 1,000 Retrieve calls (pricing page; confirmed on the
// AWS bill 2026-11-24: 1,644 queries billed at $1.644 before credits).
// First messages make one search; follow-ups make two (latest alone + latest with previous).
export const KB_SEARCH_PRICE_USD = 0.001;

export interface ReplyCost {
  claude_usd: number | null; // null when the model has no price listed here
  search_usd: number;
  total_usd: number | null;
}

export function replyCost(r: { model: string; input_tokens: number; output_tokens: number; turn: number }): ReplyCost {
  const price = CLAUDE_PRICE_PER_MTOK[r.model];
  const claude_usd = price ? (r.input_tokens * price.input + r.output_tokens * price.output) / 1e6 : null;
  const search_usd = (r.turn > 1 ? 2 : 1) * KB_SEARCH_PRICE_USD;
  return { claude_usd, search_usd, total_usd: claude_usd == null ? null : claude_usd + search_usd };
}
