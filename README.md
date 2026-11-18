# Support Agent for Wix (Concept)

RAG support chat: Bedrock Knowledge Base retrieval, Claude structured answers, public demo on Vercel.

**Live demo:** https://customer-support-agent-coral.vercel.app

## Product brief

**User:** Small business owner stuck mid-task who wants steps, not article links.

**Problem:** Search returns articles; users bail to paid support. The bot answers from articles or hands off when they cannot.

**Success (production):** Conversations resolved without a human, with guardrails on wrong answers and unnecessary escalations.

**Prototype stand-ins (400 WixQA questions):** Right article reaches Claude **95%** (measured). Fully correct answer **~90%** (simulated, not Haiku). Baseline search: **69%** right article first, **89.8%** in top 3.

Caveats: 340 of 500 KB articles are ground-truth for the test set (easier than production). Answer-quality sim used a stronger model self-grading.

**Next:** Full WixQA article set for retrieval eval · Haiku answer-quality eval with human spot-checks · *(done)* auto handoff + escalation eval · *(done)* signal logging + thumbs feedback · End-to-end latency/cost.

## How it works

```
Browser → /api/chat → Bedrock Retrieve (10 chunks → top 5 articles; follow-ups merge 2 searches)
                    → Claude (structured JSON: answer, mood, categories, handoff flag, follow-ups)
```

Side panels: thinking, categories, and source articles. Env vars: `.env.local.example`.

## Handoff

`redirect_to_agent` opens a mock ticket immediately (no extra click): queue from category, priority from keywords/mood, summary + transcript. Stored in Redis; owner `GET /api/handoff`. Visitors: 3/day.

**Escalation eval (33 cases, Haiku):** 100% recall on must-escalate; ~6% false handoffs on answerable questions (`data/eval/results/escalation-summary.json`).

## Feedback

Each reply is logged (question, answer, mood, categories, handoff, sources, timing, tokens). Thumbs up/down on thumbs down asks a reason. Owner `GET /api/feedback`; export via `feedback:export` → `data/feedback/` (gitignored). Records kept 30 days.

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
| **Escalation** | **100%** needed handoffs; **94%** precision (`escalation-summary.json`) |

Search eval used an easy subset (many articles are direct answers to test questions). Answer sim is not the live Haiku app.

## Cost

Haiku: fractions of a cent per question. Bedrock KB: storage + retrieve. Vercel/Upstash: free tier for demo scale.

## Layout

```
app/api/{chat,feedback,handoff,session}/   server routes
app/lib/                                   retrieval, access, handoff, signals
components/                                chat + sidebars
data/{kb,eval}/                            articles and eval sets
infra/knowledge-base.yaml
scripts/                                   tests and offline evals
```

## Credits

[Anthropic quickstart](https://github.com/anthropics/claude-quickstarts); WixQA (Cohen et al., [arXiv:2505.08643](https://arxiv.org/abs/2505.08643)) — see `data/README.md`.
