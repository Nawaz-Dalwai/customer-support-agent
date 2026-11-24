# Support Agent for Wix (Concept)

RAG support chat: Bedrock Knowledge Base retrieval, Claude structured answers, public demo on Vercel.

**Live demo:** https://customer-support-agent-coral.vercel.app

## Product brief

**User:** Small business owner stuck mid-task who wants steps, not article links.

**Problem:** Search returns articles; users bail to paid support. The bot answers from articles or hands off when they cannot.

**Success (production):** Conversations resolved without a human, with guardrails on wrong answers and unnecessary escalations.

**Prototype stand-ins (400 WixQA questions):** Right article reaches Claude **95%** (measured). Fully correct answer **~90%** (simulated, not Haiku). Baseline search: **69%** right article first, **89.8%** in top 3.

Caveats: 340 of 500 KB articles are ground-truth for the test set (easier than production). Answer-quality sim used a stronger model self-grading.

**Next:** Full WixQA article set for retrieval eval · Haiku answer-quality eval with human spot-checks · *(done)* auto handoff + escalation eval · *(done)* "Did this fix it?" outcomes · *(done)* selectable handoff policy · *(done)* insights page with cost per reply · *(done)* monthly self-review that proposes fixes.

## How it works

```
Browser → /api/chat → Bedrock Retrieve (10 chunks → top 5 articles; follow-ups merge 2 searches)
                    → Claude (structured JSON: answer, mood, categories, handoff flag, follow-ups)
```

Side panels: thinking, categories, and source articles. Env vars: `.env.local.example`.

## Handoff

`redirect_to_agent` opens a mock ticket immediately (no extra click): queue from category, priority from keywords/mood, summary + transcript. Stored in Redis; owner `GET /api/handoff`. Visitors: 3/day.

**Handoff policy.** Anyone can pick how readily the bot hands off, per chat: **Cautious** (hand off whenever unsure or money, access or security is involved), **Balanced** (default: answer what the articles cover), **Resolve-first** (hand off only when a person is asked for or staff must decide). Each level is a different handoff rule in the prompt; the level is logged on every reply. A Compare panel in the chat shows the measured trade-off:

| Policy | Needed handoffs caught | Unneeded handoffs |
|---|---|---|
| Cautious | 100% (17/17) | 69% (11/16) |
| Balanced | 100% (17/17) | 6% (1/16) |
| Resolve-first | 71% (12/17) | 6% (1/16) |

33 hand-labelled conversations through the app's own `/api/chat` route (run locally) on Haiku (`npm run eval:escalation -- --levels cautious,balanced,resolve_first`; results in `data/eval/results/escalation-<level>-summary.json`). Labels follow Balanced's rules, so Resolve-first's 5 misses are the off-topic and not-covered questions it is told to answer instead. Small sample: read the gaps, not the exact percentages.

## Feedback

Each reply is logged (question, answer, mood, categories, handoff, policy, sources, timing, tokens). Instead of thumbs, answers ask **"Did this fix it?"**: numbered steps get tick boxes, **Still stuck** asks why, then offers **Try again** (a follow-up worded for the reason, or a prompt to rephrase) or a person (the ticket carries the reason and the steps already tried); `/insights` shows how often a retry fixed it, and handoff replies offer **Didn't need a person?** to catch unnecessary escalations. Owner `GET /api/feedback`; export via `feedback:export` → `data/feedback/` (gitignored). Records kept 30 days.

## Insights

`/insights` turns the reply records into a report: resolved %, handoff %, unneeded handoffs, reply time and estimated cost per reply; resolution and handoffs by category; why customers got stuck; each handoff policy in real use next to its eval numbers; and the latest problem replies with the articles used.

Visitors see **labelled sample data** (150 records built by `npm run build:insights-sample` from public WixQA questions and the escalation test cases; outcomes and timings simulated). Real records contain visitors' questions, so **live data is owner-only**, checked server-side (`GET /api/insights?source=live`).

## Monthly self-review

Once a month (Vercel Cron, `vercel.json`) the app reviews its own failures. It takes the last 30 days of problem replies (still stuck, unneeded handoffs, failed retries; up to 25), re-runs the article search for each, groups them by category and asks **Claude Sonnet 5.5** why each group failed: missing article information, a search miss, a prompt rule or the handoff policy. Each finding cites the replies and gives a concrete fix (article to extend, exact prompt wording to change).

Fixes are **proposals only**: the owner approves or rejects them under **Suggested fixes** on `/insights`, and approved ones are applied by hand in a normal commit. One run per day at most (the monthly job and the owner's **Run review now** share the limit); the cron endpoint needs `CRON_SECRET`. Visitors see 3 labelled sample findings.

Dry run on the 17 sample problem replies: 6 Claude calls, 13 findings, **$0.20**, 24 s. The 25-reply cap keeps a run under ~$0.60.

## Tech stack

| Part | What's used |
|---|---|
| App | Next.js 15, React 19, Tailwind, TypeScript |
| AI | Claude Haiku/Sonnet/Opus 5.5 (`messages.parse` + Zod) |
| Search | Bedrock Managed Knowledge Base (S3) |
| Infra | `infra/knowledge-base.yaml` (CloudFormation) |
| Host / limits | Vercel, Upstash Redis |

## Demo guardrails

Visitors: Haiku only, 500 chars, 10 questions and 3 handoffs per IP per 24h. Rate limiter down = requests refused. Owner: `/owner` + `SITE_PASSWORD`. AWS app user: `bedrock:Retrieve` on one KB only; $5/mo budget alert in stack.

## Evaluation

WixQA: 400 questions with known articles. Full numbers in `data/eval/results/`.

| Area | Headline |
|---|---|
| **Search** | Right article in context **95%** at 10 chunks / 5 articles (was 90.5% at 5) |
| **Follow-ups** | Merged search: **97.5%** vs **72.5%** message-only (`followups-summary.json`) |
| **Answers** | **90%** fully correct simulated; **97%** when retrieval hit (`simulation-summary.json`) |
| **Escalation** | Balanced: **100%** needed handoffs, **6%** unneeded; per-policy table under [Handoff](#handoff) |

Search eval used an easy subset (many articles are direct answers to test questions). Answer sim is not the live Haiku app.

## Cost

About **$0.002 per first question on Haiku**: ~6.1k input + ~420 output tokens (escalation eval average) is ~$0.0008 of Claude, and the knowledge base search is ~$0.001, so search is over half the cost. Follow-ups run two searches. Opus 5.5 costs 40x Haiku per token. Rates live in `app/lib/pricing.ts` (list prices, no prompt caching); the KB search price ($1 per 1,000) is confirmed on the AWS bill. Monthly self-review: ~$0.02 per reviewed reply on Sonnet, capped at 25 replies per run. Vercel/Upstash: free tier for demo scale.

## Layout

```
app/api/{chat,feedback,handoff,insights,review,session}/   server routes
app/insights/                              insights page
app/lib/                                   retrieval, access, handoff, signals, pricing, escalation levels, chat prompt, self-review
components/                                chat, sidebars, policy selector, insights view
data/{kb,eval}/                            articles and eval sets
infra/knowledge-base.yaml
scripts/                                   tests and offline evals
```

## Credits

[Anthropic quickstart](https://github.com/anthropics/claude-quickstarts); WixQA (Cohen et al., [arXiv:2505.08643](https://arxiv.org/abs/2505.08643)) — see `data/README.md`.
