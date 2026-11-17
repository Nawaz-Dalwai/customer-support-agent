# Support Agent for Wix (Concept)

A customer support chat assistant that answers questions from a library of help articles. It uses Claude to write the answers and an Amazon Bedrock knowledge base to find the right articles.

**Live demo:** https://customer-support-agent-coral.vercel.app

> This is a learning prototype. It is not affiliated with or endorsed by Wix and is not official Wix support. The help articles come from the public [WixQA](https://huggingface.co/datasets/Wix/WixQA) dataset (MIT License, Wix.com AI Research).

This project rebuilds Anthropic's [`customer-support-agent`](https://github.com/anthropics/claude-quickstarts/tree/main/customer-support-agent) quickstart from scratch, updated for current models and APIs.

## How it works

```
Browser (Next.js chat UI)
   │  question
   ▼
/api/chat  (Vercel serverless function)
   ├─ 1. Search: Amazon Bedrock Managed Knowledge Base  ──►  10 chunks, kept to the top 5 articles
   │        (500 help articles stored in S3)
   ├─ 2. Answer: Claude (Messages API, structured output)
   │        answers only from those chunks
   └─ 3. Reply: answer + top 3 sources + mood, categories, "needs a human?" flag
```

Each reply is a JSON object that has to match a schema (`app/api/chat/route.ts`). It holds:

- `response`: the answer in Markdown
- `thinking`: a short note on how Claude approached the question (shown in the left panel)
- `suggested_questions`: up to 3 follow-up questions
- `user_mood` and `matched_categories`: used for reporting
- `redirect_to_agent`: set when the question needs a human, such as a refund dispute, account recovery, or anything the articles don't cover

The right panel shows which help articles were used for each answer.

## Tech stack

| Part | What's used |
|---|---|
| App | Next.js 15, React 19, Tailwind, TypeScript |
| AI model | Claude Haiku 5.5 (default), Sonnet 5.5, Opus 5.5 through the Anthropic SDK, with structured outputs (`messages.parse` + Zod) |
| Search | Amazon Bedrock **Managed** Knowledge Base over an S3 bucket |
| Infrastructure | One CloudFormation stack (`infra/knowledge-base.yaml`) |
| Hosting | Vercel, deployed from `main` |
| Rate limiting | Upstash Redis |

## Demo guardrails

The public demo is open to everyone, so usage is capped:

- Visitors can use only **Claude Haiku 5.5**, with **500 characters** per question and **10 questions per 24 hours** per IP address.
- If the rate limiter is unavailable, requests are refused rather than let through unlimited.
- The owner signs in at `/owner` to unlock all models with no limits. A signed cookie keeps them signed in.
- If the Claude API spend limit is reached, the chat shows a friendly "usage limit reached" message.
- The AWS app user can only call `bedrock:Retrieve` on this one knowledge base, and a monthly AWS budget alert is part of the stack.

## Evaluation

The 400 test questions come from WixQA: 200 written by experts and 200 simulated. Each one has a known correct article.

**Search (all 400 questions, measured):**

| Measure | 5 chunks (first version) | 10 chunks, top 5 articles (current) |
|---|---|---|
| Correct article ranked first | 69% | 69% |
| Correct article in the 3 sources shown | 89% | 89.8% |
| Correct article anywhere in what Claude reads | 90.5% | 95% |
| Questions needing several articles: all of them found | 49% | 70% |
| Article text sent to Claude per question | ~5,900 chars | ~10,900 chars |

The current setting came from a sweep (`npm run eval:retrieval:sweep`) that tried 5, 10, 15 and 20 chunks. Going past 10 added text without finding more articles. Fetching more chunks doesn't change which article ranks first.

**Answer quality (100-question sample, simulated):**

| Measure | Result |
|---|---|
| Fully correct | 90% |
| Correct and complete | 76% |
| Wrong answers / made-up claims | 0% / 0% |
| Fully correct when search found the right article | 97% |
| Fully correct when search missed it | 36% |

The answer quality numbers are an **offline simulation** of the first version (5 chunks), not a test of the live app. One model wrote answers using the app's prompt and the same retrieved articles, and the same model then graded them against the expert answers. Treat them as an estimate. The main finding still holds: most weak answers come from search misses, so better search is the next improvement.

Full results are in `data/eval/results/`.

## Run it locally

You need Node.js 20+, a Claude API key, and an AWS account with Amazon Bedrock access in `us-east-1`.

**1. Install**

```bash
npm install
cp .env.local.example .env.local
```

**2. Create the AWS resources**

```bash
aws cloudformation deploy \
  --template-file infra/knowledge-base.yaml \
  --stack-name customer-support-kb \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides BudgetAlertEmail=you@example.com
```

This creates the S3 bucket, the knowledge base and its data source, a read-only app user, and the budget alert. Get the bucket name, knowledge base ID, and data source ID from the stack outputs:

```bash
aws cloudformation describe-stacks --stack-name customer-support-kb \
  --query "Stacks[0].Outputs"
```

**3. Upload the articles and index them**

```bash
aws s3 sync data/kb s3://<BucketName>/
aws bedrock-agent start-ingestion-job \
  --knowledge-base-id <KnowledgeBaseId> --data-source-id <DataSourceId>
```

**4. Create an access key for the app user** (`AppUserName` in the outputs) and fill in `.env.local`. Every variable is described in `.env.local.example`.

**5. Check the connections, then start the app**

```bash
npm run test:anthropic   # Claude key works
npm run test:kb          # knowledge base returns the right articles
npm run dev              # http://localhost:3000
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` | Run or build the app with both side panels |
| `npm run dev:chat` | Chat only, no side panels (also `dev:left`, `dev:right`) |
| `npm run typecheck` / `lint` | TypeScript and ESLint checks |
| `npm run test:anthropic` | One small Claude call to confirm the API key |
| `npm run test:kb` | 10 sample searches against the knowledge base |
| `npm run eval:retrieval` | Search evaluation on all 400 questions at 5 chunks (AWS only, no Claude cost) |
| `npm run eval:retrieval:sweep` | One 20-chunk search per question, scored at 5/10/15/20 chunks and 3/5 articles |
| `npm run eval:sim:prepare` | Builds the input for the offline answer simulation |

## Cost

- **Claude:** each visitor question to Haiku costs a fraction of a cent. The demo runs under a small monthly spend limit set in the Claude Console.
- **AWS:** a Bedrock Managed Knowledge Base charges for the content it stores and for searches. A $5/month budget alert emails the owner before costs grow.
- **Vercel and Upstash:** free tiers.

## Project layout

```
app/api/chat/route.ts     chat endpoint: search, Claude call, response schema
app/api/session/route.ts  tells the UI whether the viewer is the owner or a visitor
app/owner/route.ts        owner sign-in
app/lib/                  access rules, model list, knowledge base search, categories
components/               chat area and side panels
infra/knowledge-base.yaml CloudFormation stack
data/                     WixQA articles and test questions (see data/README.md)
scripts/                  connection tests and evaluation scripts
```

## Credits

- Based on [anthropics/claude-quickstarts](https://github.com/anthropics/claude-quickstarts) `customer-support-agent`.
- Help articles and test questions from WixQA: Cohen et al., 2025, *WixQA: A Multi-Dataset Benchmark for Enterprise Retrieval-Augmented Generation* ([arXiv:2505.08643](https://arxiv.org/abs/2505.08643)). Licensing details are in `data/README.md`.
