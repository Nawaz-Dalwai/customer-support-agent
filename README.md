# Support Agent for Wix (Concept)

A customer support chat assistant that answers questions from a library of help articles. It uses Claude to write the answers and an Amazon Bedrock knowledge base to find the right articles.

**Live demo:** https://customer-support-agent-coral.vercel.app

> This is a learning prototype. It is not affiliated with or endorsed by Wix and is not official Wix support. The help articles come from the public [WixQA](https://huggingface.co/datasets/Wix/WixQA) dataset (MIT License, Wix.com AI Research).

This project rebuilds Anthropic's [`customer-support-agent`](https://github.com/anthropics/claude-quickstarts/tree/main/customer-support-agent) quickstart from scratch, updated for current models and APIs.

## Product brief

**The user.** A small business owner who built their site on a website platform and is stuck partway through a task, such as connecting a domain, setting up payments, or fixing the mobile layout. They usually aren't technical, and they want the exact steps for their situation right now, not a list of articles to read.

**The problem.** A help center search returns articles, not answers. The user has to pick the right article, read it, and work out how it applies to them. When that fails, they contact support, and a paid human answers a question the help articles already covered. Meanwhile, the questions that really need a person (refund disputes, account recovery, security) wait in the same queue.

The assistant answers from the help articles when they cover the question. When they don't, it says so and offers a human instead of guessing.

**The success metric.**

- **In production:** the share of conversations resolved correctly without a human. A conversation counts as resolved when there's no escalation, no repeat contact on the same topic within 7 days, and no negative feedback. Two guardrails come with it: the wrong-answer rate on a human-reviewed weekly sample (proposed bar: under 2%), and how often escalations were actually needed. A bot that never escalates can hit the main metric while failing users.
- **In this prototype (no real users yet):** two stand-ins measured on the 400 WixQA test questions. The first is how often the right article reaches Claude: **95%**, measured. The second is how often the answer is fully correct: **90%**, simulated on the first version.

**The baseline.** Without the assistant, the user gets search results over the same articles. On the same test set, search alone puts the right article first **69%** of the time and in the top 3 **89.8%** of the time. So about a third of users would need to look past the first result, and about 1 in 10 wouldn't find it in the top 3 at all. To be worth building, the assistant has to beat "read the top article yourself." That means a correct answer when the article is found (97% fully correct, simulated) and a handoff instead of a guess when it isn't.

These numbers are optimistic, for two reasons:

- 340 of the 500 articles in the knowledge base answer a test question, so search has far fewer wrong articles to get past than in a real help center.
- The answer-quality figures come from a stronger model grading its own answers, not from the Haiku model the demo uses.

Not measured yet: plain keyword search, and how human agents perform on the same questions.

**What I'd do next, and why** (in order):

1. **Test against the full WixQA article set.** Every other decision depends on numbers I can trust, and the current test set is too easy.
2. **Evaluate the model that actually ships.** Run the answer eval with Haiku at low effort, and have a person grade 30 answers to check the AI grader. Haiku is the default for cost reasons, and there's no evidence yet that its quality is good enough.
3. **Make the handoff to a human real, and test it.** The costliest failure is a user who stays stuck. *Done as a mock:* when the assistant decides a person is needed, it now opens a routed, prioritized ticket automatically, and a 33-case escalation test set runs against the live app (see [Handoff to a human](#handoff-to-a-human)). Still open: whether a refund request the articles say Customer Care reviews should go straight to a person.
4. **Log the signals and add thumbs up/down.** Each reply already includes mood, categories and the escalation flag, but they only went to the server log. Storing them is how a wrong answer turns into a help article fix and a new eval case. *Done:* every reply is logged with its feedback, and thumbs-down replies export to a triage file (see [Signals and feedback](#signals-and-feedback)). Not measured yet: real visitor ratings.
5. **Measure time to answer and cost per conversation.** Both are needed for the business case, and neither is measured from start to finish yet.

New features and more models wait until steps 1 to 3 are done, because until then I can't tell whether a change helps.

## How it works

```
Browser (Next.js chat UI)
   │  question
   ▼
/api/chat  (Vercel serverless function)
   ├─ 1. Search: Amazon Bedrock Managed Knowledge Base  ──►  10 chunks, kept to the top 5 articles
   │        (500 help articles stored in S3; follow-ups also search with the previous question)
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

## Handoff to a human

When a reply sets `redirect_to_agent`, the chat hands off right away, with no extra click. It sends the conversation to `/api/handoff`, which creates a support ticket, and shows a confirmation card under the reply: the ticket ID, the team queue, and the priority. The card also has a "What the agent sees" view. The system prompt tells Claude that the handoff is automatic, so the reply says the conversation has been passed on instead of asking the user to confirm or wait. If creating the ticket fails, the card offers a "Try again" button.

The ticket is what a help desk agent would pick up (`app/lib/handoff.ts`):

- **Queue:** chosen from the first matched category, for example `account` goes to Account & Security and `billing` to Billing. Anything else goes to General Support.
- **Priority:** `urgent` if the conversation mentions things like "hacked", "fraud" or "lawyer"; `high` if the customer seems frustrated or it's a billing or payments issue; otherwise `normal`. The reason is stored with the ticket.
- **Summary and transcript:** the first and latest customer messages, why the assistant handed off, and the whole conversation, so the customer doesn't have to repeat themselves.

This is a mock help desk. Tickets are saved in Upstash Redis (the newest 100), and the owner can list them at `GET /api/handoff`. No real agent is notified, and the card tells visitors so. Visitors can create 3 tickets per 24 hours.

## Signals and feedback

Every reply is logged once it has been sent, so logging never slows the chat (`app/lib/signals.ts`). Each record holds:

- the question and the reply
- what Claude returned: mood, categories, whether it handed off and why, and whether it used the articles
- the sources shown, with their scores
- search and total time, token counts, and the model
- whether it was a safety refusal

Under each reply, visitors can give a thumbs up or down. A thumbs down asks what went wrong:

- Incorrect
- Didn't answer my question
- Missing steps
- Should have connected me to a person, or Didn't need a person if the reply handed off

The rating is saved on that reply's record, and a later vote replaces an earlier one. Records are kept in Upstash Redis for 30 days (the newest 1,000), and the chat footer tells visitors so.

**Closing the loop:**

1. `GET /api/feedback` (owner only) reports the share of replies rated, the thumbs-up rate, and the handoff rate, plus how often the articles weren't used, broken down by category, mood and model. It also lists every thumbs-down reply. The owner's own test chats are left out unless you add `?include_owner=1`.
2. `npm run feedback:export` saves that report and writes each thumbs-down reply to `data/feedback/triage-<date>.jsonl`, with a suggested cause:
   - **Escalation:** the visitor said it should or shouldn't have handed off. Add the case to `data/eval/escalation.jsonl`.
   - **Search miss or missing article:** the articles weren't used, or the visitor said it didn't answer. If an article answers it, add the question to the search eval; if not, it's a content gap.
   - **Answer quality:** the right sources were shown, but the reply was wrong or incomplete. Look at the prompt or the model.
3. After fixing, re-run the matching eval to confirm the fix and to catch regressions.

`data/feedback/` is git-ignored because it holds real visitor questions.

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
- Visitors can be handed to a human **3 times per 24 hours**, so the mock ticket queue can't be flooded.
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

**Reranking is already on.** A check on 100 questions (`npm run eval:reranking`) found that leaving `rerankingModelType` out gives exactly the same order and scores as `MANAGED`. Turning reranking off (`NONE`) lowered "right article first" from 69% to 66%.

**Follow-up questions (80 two-message cases, measured):**

A follow-up like "what if that fails?" doesn't name its topic. For the 2nd and later messages, the app makes two searches: one with the newest message alone, and one with the newest message plus the visitor's previous one. It merges the results by reciprocal rank fusion.

| Right article reaches Claude | Newest message only | Merged (current) |
|---|---|---|
| Follow-ups that depend on the previous message (40) | 72.5% | 97.5% |
| Complete new question on a different topic (40) | 100% | 92.5% |

The trade-off is that 45% of topic changes also bring in an article from the earlier topic. Claude sees the whole conversation, so it can tell which articles apply. These cases were written by Claude from WixQA questions, not taken from real conversations (`data/eval/followups.jsonl`).

**Answer quality (100-question sample, simulated):**

| Measure | Result |
|---|---|
| Fully correct | 90% |
| Correct and complete | 76% |
| Wrong answers / made-up claims | 0% / 0% |
| Fully correct when search found the right article | 97% |
| Fully correct when search missed it | 36% |

**After the search changes (simulation, 11 questions):** the 11 sample questions where the first version's search missed the right article were re-answered with the current search. Fully correct answers went from 36% to 91% (4 to 10 of 11). The other 89 questions weren't re-run. If they're unchanged, the estimate for all 100 rises from 90% to 96% fully correct. Details are in `data/eval/results/simulation-v2-subset-summary.json`.

The answer quality numbers are an **offline simulation** of the first version (5 chunks), not a test of the live app. One model wrote answers using the app's prompt and the same retrieved articles, and the same model then graded them against the expert answers. Treat them as an estimate. The main finding still holds: most weak answers come from search misses, so better search is the next improvement.

**Escalation (33 hand-written cases, measured on the app with Claude Haiku 5.5):**

`data/eval/escalation.jsonl` has 17 cases that must go to a human and 16 that must not. The first group covers asking for a person, refund disputes, account takeover, account-specific questions, legal issues, off-topic requests, and questions the articles don't cover. The second group includes sensitive-sounding questions the articles do answer, such as refund policy, account recovery and chargebacks. `npm run eval:escalation` sends every case through the real `/api/chat` route and checks the `redirect_to_agent` flag on the last reply.

| Measure | First prompt (handoff offered) | Current prompt (handoff automatic) |
|---|---|---|
| Cases that needed a human and got the handoff | 100% (17 of 17) | 100% (17 of 17) |
| Handoffs that were needed | 89.5% (17 of 19) | 94.4% (17 of 18) |
| Answerable questions handed off anyway | 12.5% (2 of 16) | 6.3% (1 of 16) |

With the first prompt, both false handoffs gave a complete self-service answer and then *also* offered a human: domain refunds and account recovery. That prompt listed "refund disputes, account recovery" as reasons to hand off. Once the handoff became automatic, each of these would open a ticket nobody needed. So the prompt now says to answer, without handing off, when the articles fully cover the question, even on sensitive topics. Account recovery is now answered with the self-service steps. Domain refunds still hand off, because the article itself says Customer Care reviews refund requests, so this is a borderline case.

Results vary between runs: in an earlier run with the first prompt, the account recovery case was answered without a handoff. One case was relabeled after the first run because the article didn't actually cover it (what to do when the email-change code never arrives). Results are in `data/eval/results/escalation-summary.json`.

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

Indexing takes a few minutes (about 3.5 for the 500 articles), and searches return nothing until it finishes. Check its progress with the `ingestionJobId` from the previous command, and wait for `COMPLETE`:

```bash
aws bedrock-agent get-ingestion-job \
  --knowledge-base-id <KnowledgeBaseId> --data-source-id <DataSourceId> \
  --ingestion-job-id <ingestionJobId> --query "ingestionJob.[status,statistics]"
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
| `npm run eval:followups` | Two-message cases: newest message only vs. combined vs. merged searches |
| `npm run eval:escalation` | Sends the 33 escalation cases through the running app as the owner (`BASE_URL`, default `http://localhost:3000`; optional model id argument). Costs one Claude call per message |
| `npm run feedback:export` | Pulls the owner feedback report (`BASE_URL`, default the live demo) and writes thumbs-down replies to a triage file; `-- --include-owner` adds your own test chats |
| `npm run eval:reranking` | 100 questions searched with reranking left out, `MANAGED` and `NONE` |
| `npm run eval:sim:prepare` | Builds the input for the offline answer simulation |

## Cost

- **Claude:** each visitor question to Haiku costs a fraction of a cent. The demo runs under a small monthly spend limit set in the Claude Console.
- **AWS:** a Bedrock Managed Knowledge Base charges for the content it stores and for searches. A $5/month budget alert emails the owner before costs grow.
- **Vercel and Upstash:** free tiers.

## Project layout

```
app/api/chat/route.ts     chat endpoint: search, Claude call, response schema
app/api/feedback/route.ts thumbs up/down on a reply; owner report over the logged reply signals
app/api/handoff/route.ts  human handoff: creates a mock support ticket; owner lists tickets
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
