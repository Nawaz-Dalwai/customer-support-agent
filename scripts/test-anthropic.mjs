// Smoke test: can we reach Claude with the key in .env.local?
// Run with: npm run test:anthropic
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-4-5-20251001"; // the app's default model

const key = process.env.ANTHROPIC_API_KEY?.trim();
if (!key) {
  console.error("❌ ANTHROPIC_API_KEY is missing.");
  console.error("   Copy .env.local.example to .env.local and paste your key after ANTHROPIC_API_KEY=");
  process.exit(1);
}
if (!key.startsWith("sk-ant-")) {
  console.warn("⚠️  Key doesn't start with 'sk-ant-' — double-check you copied the whole key.");
}
console.log(`🔑 Key found (${key.slice(0, 7)}…, ${key.length} chars)`);

const client = new Anthropic({ apiKey: key });

try {
  const start = performance.now();
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 50,
    messages: [{ role: "user", content: "Reply with exactly: Connection OK" }],
  });
  const secs = ((performance.now() - start) / 1000).toFixed(2);
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");

  console.log("✅ Claude responded");
  console.log(`   model:   ${msg.model}`);
  console.log(`   reply:   ${text.trim()}`);
  console.log(`   tokens:  ${msg.usage.input_tokens} in / ${msg.usage.output_tokens} out`);
  console.log(`   latency: ${secs}s`);
} catch (err) {
  const status = err?.status;
  const hints = {
    401: "Invalid API key — create a new one at console.anthropic.com → API Keys.",
    403: "Key lacks permission for this model or workspace.",
    404: `Model "${MODEL}" not found for this account.`,
    429: "Rate limited — wait a minute and retry.",
    529: "Anthropic API is overloaded — retry shortly.",
  };
  const msgText = String(err?.message ?? err);
  const hint =
    hints[status] ??
    (/credit|billing|balance/i.test(msgText)
      ? "No credit on the account — add credits under Billing in the console."
      : "See the error message above.");

  console.error(`❌ Claude request failed${status ? ` (HTTP ${status})` : ""}`);
  console.error(`   ${msgText}`);
  console.error(`   → ${hint}`);
  process.exit(1);
}
