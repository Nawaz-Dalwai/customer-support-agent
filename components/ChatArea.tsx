"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Components } from "react-markdown";
import config from "@/config";
import { MODELS, DEFAULT_MODEL_ID, type ChatModel } from "@/app/lib/models";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import {
  HandHelping,
  LifeBuoyIcon,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Send,
  Bot,
  CircleCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { HandoffTicket } from "@/app/lib/handoff";
import {
  FEEDBACK_REASONS,
  STUCK_REASONS,
  type OutcomeResult,
  type StuckReason,
} from "@/app/lib/feedback-reasons";
import { STARTER_QUESTIONS } from "@/app/lib/starter-questions";
import { DEFAULT_ESCALATION_LEVEL, type EscalationLevel } from "@/app/lib/escalation-levels";
import PolicySelector, { PolicyToggle } from "@/components/PolicySelector";
import "highlight.js/styles/atom-one-dark.css";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Neutral assistant avatar (no third-party logos)
const BotAvatar = ({
  className = "",
  iconClassName = "w-5 h-5",
}: {
  className?: string;
  iconClassName?: string;
}) => (
  <Avatar className={`border ${className}`}>
    <AvatarFallback className="bg-primary text-primary-foreground">
      <Bot className={iconClassName} aria-label="Support assistant" />
    </AvatarFallback>
  </Avatar>
);

const TypedText =({ text = "", delay = 5 }) => {
  const [displayedText, setDisplayedText] = useState("");

  useEffect(() => {
    if (!text) return;
    const timer = setTimeout(() => {
      setDisplayedText(text.substring(0, displayedText.length + 1));
    }, delay);
    return () => clearTimeout(timer);
  }, [text, displayedText, delay]);

  return <>{displayedText}</>;
};

type ThinkingContent = {
  id: string;
  content: string;
  user_mood: string;
  debug: any;
  matched_categories?: string[];
};

type HandoffState =
  | { status: "loading" }
  | { status: "done"; ticket: HandoffTicket; stored: boolean }
  | { status: "error"; message: string };

const PRIORITY_STYLES: Record<HandoffTicket["priority"], string> = {
  urgent: "bg-red-100 text-red-800",
  high: "bg-amber-100 text-amber-800",
  normal: "bg-gray-100 text-gray-800",
};

const HandoffTicketCard = ({ ticket, stored }: { ticket: HandoffTicket; stored: boolean }) => (
  <div className="mt-3 rounded-md border bg-background p-3 text-sm">
    <div className="flex items-center gap-2 font-medium">
      <CircleCheck className="w-4 h-4 text-green-600" />
      You&apos;re in the queue for the {ticket.queue} team
    </div>
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <span className="font-mono">{ticket.id}</span>
      <span className={`rounded-full px-2 py-0.5 ${PRIORITY_STYLES[ticket.priority]}`}>
        {ticket.priority} priority
      </span>
    </div>
    <p className="mt-2 text-muted-foreground">
      The agent receives this whole conversation, so you won&apos;t need to repeat yourself.
    </p>
    <p className="mt-1 text-xs text-muted-foreground">
      This is a demo: no agents are staffed, so nobody will reply.
      {!stored && " The ticket was not saved."}
    </p>
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground">What the agent sees</summary>
      <dl className="mt-2 space-y-1">
        <div>
          <dt className="inline font-medium">Why it was handed off: </dt>
          <dd className="inline">{ticket.escalation_reason}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Priority: </dt>
          <dd className="inline">
            {ticket.priority} ({ticket.priority_reason})
          </dd>
        </div>
        <div>
          <dt className="inline font-medium">Mood: </dt>
          <dd className="inline">{ticket.user_mood}</dd>
        </div>
        {ticket.customer_progress && (
          <div>
            <dt className="inline font-medium">Progress: </dt>
            <dd className="inline">{ticket.customer_progress}</dd>
          </div>
        )}
        <div>
          <dt className="font-medium">Summary:</dt>
          <dd className="whitespace-pre-wrap">{ticket.summary}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Transcript: </dt>
          <dd className="inline">{ticket.transcript.length} messages attached</dd>
        </div>
      </dl>
    </details>
  </div>
);

const UISelector = ({
  redirectToAgent,
  handoff,
  onRequestHandoff,
}: {
  redirectToAgent: { should_redirect: boolean; reason: string };
  handoff?: HandoffState;
  onRequestHandoff?: () => void;
}) => {
  if (!redirectToAgent.should_redirect || !onRequestHandoff) return null;

  if (handoff?.status === "done") {
    return <HandoffTicketCard ticket={handoff.ticket} stored={handoff.stored} />;
  }

  if (handoff?.status === "error") {
    return (
      <>
        <p className="mt-2 text-xs text-red-600">{handoff.message}</p>
        <Button size="sm" className="mt-2 flex items-center space-x-2" onClick={onRequestHandoff}>
          <LifeBuoyIcon className="w-4 h-4" />
          <small className="text-sm leading-none">Try again</small>
        </Button>
      </>
    );
  }

  // The ticket is requested automatically as soon as the reply arrives
  return (
    <div className="mt-2 flex items-center text-xs text-muted-foreground">
      <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-gray-500 mr-2" />
      Opening a ticket with our support team…
    </div>
  );
};

type OutcomeState = {
  result: OutcomeResult;
  reason: StuckReason | null;
  status: "saving" | "saved" | "error";
};

// "Try again" after a stuck reason: a visible follow-up sent as the customer, worded for the reason.
// "Didn't answer my question" only fills the message box: a generic retry would find the same
// articles, so the customer says what they meant instead.
const RETRY_MESSAGES: Record<StuckReason, string> = {
  didnt_work: "I tried those steps and it didn't work. Is there another way to do this?",
  incomplete: "Some steps seem to be missing. Can you give me the complete steps?",
  incorrect: "That doesn't look right for my situation. Can you check again?",
  not_answered: "What I meant was: ",
};
const RETRY_FILLS_INPUT: StuckReason = "not_answered";

// Asked under every answer that didn't hand off: the outcome, not a rating, is the success metric.
// "Still stuck" asks why, then offers to try again (latest reply only) or a person; on a handoff
// reply the customer can say it wasn't needed.
const ReplyOutcome = ({
  handedOff,
  outcome,
  steps,
  handoff,
  onReport,
  onTalkToPerson,
  canRetry,
  retried,
  onTryAgain,
}: {
  handedOff: boolean;
  outcome?: OutcomeState;
  steps: { done: number; total: number };
  handoff?: HandoffState;
  onReport: (result: OutcomeResult, reason: StuckReason | null) => void;
  onTalkToPerson: () => void;
  canRetry: boolean; // latest reply, not loading, questions left
  retried: boolean;
  onTryAgain: (reason: StuckReason) => void;
}) => {
  const saveError = outcome?.status === "error" && (
    <span className="ml-1 text-red-600">Couldn&apos;t save your answer</span>
  );

  if (handedOff) {
    return (
      <div className="mt-1 pl-10 text-xs text-muted-foreground">
        {outcome?.result === "unneeded_handoff" ? (
          outcome.status !== "error" && <span>Thanks, we&apos;ll use that to hand off less often.</span>
        ) : (
          <Button
            variant="link"
            size="sm"
            className="h-6 p-0 text-xs text-muted-foreground"
            onClick={() => onReport("unneeded_handoff", null)}
          >
            Didn&apos;t need a person for this?
          </Button>
        )}
        {saveError}
      </div>
    );
  }

  const choice = (result: "resolved" | "stuck", label: string) => {
    const active = outcome?.result === result;
    return (
      <Button
        variant={active ? "secondary" : "outline"}
        size="sm"
        className="h-7 px-2.5 text-xs"
        aria-pressed={active}
        onClick={() => onReport(result, null)}
      >
        {label}
      </Button>
    );
  };

  return (
    <div className="mt-1.5 pl-10 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground/80">Did this fix it?</span>
        {choice("resolved", "Yes, fixed")}
        {choice("stuck", "Still stuck")}
        {steps.total > 0 && !outcome && (
          <span>
            {steps.done} of {steps.total} steps done
          </span>
        )}
        {outcome?.result === "resolved" && outcome.status === "saved" && <span>Glad that worked.</span>}
        {saveError}
      </div>
      {outcome?.result === "stuck" && (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span>What went wrong?</span>
            {STUCK_REASONS.map((r) => (
              <Button
                key={r}
                variant={outcome.reason === r ? "secondary" : "outline"}
                size="sm"
                className="h-6 px-2 text-xs"
                aria-pressed={outcome.reason === r}
                onClick={() => onReport("stuck", r)}
              >
                {FEEDBACK_REASONS[r]}
              </Button>
            ))}
          </div>
          {handoff?.status === "done" ? (
            <HandoffTicketCard ticket={handoff.ticket} stored={handoff.stored} />
          ) : handoff?.status === "loading" ? (
            <div className="flex items-center">
              <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-gray-500 mr-2" />
              Opening a ticket with our support team…
            </div>
          ) : (
            <>
              {outcome.reason && outcome.status !== "error" && (
                <p>
                  <span className="font-medium text-foreground/80">Thanks, noted.</span>{" "}
                  {retried
                    ? outcome.reason === RETRY_FILLS_INPUT
                      ? "Finish your message below and send it."
                      : "I've asked again below."
                    : canRetry
                      ? "Want me to try again, or talk to a person?"
                      : "You can talk to a person if you're still stuck."}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {outcome.reason && canRetry && !retried && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    onClick={() => onTryAgain(outcome.reason!)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {outcome.reason === RETRY_FILLS_INPUT ? "Rephrase my question" : "Try again"}
                  </Button>
                )}
                <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={onTalkToPerson}>
                  <LifeBuoyIcon className="h-3.5 w-3.5" />
                  Talk to a person
                </Button>
              </div>
              {handoff?.status === "error" && <p className="text-red-600">{handoff.message}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
};

// ---- Numbered steps as a checklist ------------------------------------------------------
// Each numbered list item in an answer gets a tick box, keyed by its line in the Markdown so
// the state survives re-renders. The count of ticked steps goes with "Did this fix it?" and
// into the ticket if the customer asks for a person.
type StepChecklist = { checked: number[]; toggle: (line: number) => void };
const StepsContext = createContext<StepChecklist | null>(null);
const InOrderedList = createContext(false);

const countSteps = (markdown: string) => (markdown.match(/^\s*\d+[.)]\s+\S/gm) ?? []).length;

const checklistComponents: Components = {
  ol: ({ node: _node, children, ...props }) => (
    <InOrderedList.Provider value>
      <ol {...props} className="my-2 list-none space-y-1.5 pl-0">
        {children}
      </ol>
    </InOrderedList.Provider>
  ),
  ul: ({ node: _node, children, ...props }) => (
    <InOrderedList.Provider value={false}>
      <ul {...props}>{children}</ul>
    </InOrderedList.Provider>
  ),
  li: function ChecklistItem({ node, children, ...props }) {
    const steps = useContext(StepsContext);
    const ordered = useContext(InOrderedList);
    const line = node?.position?.start.line;
    if (!steps || !ordered || line === undefined) return <li {...props}>{children}</li>;
    const done = steps.checked.includes(line);
    return (
      <li {...props} className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={done}
          onChange={() => steps.toggle(line)}
          aria-label={done ? "Mark step as not done" : "Mark step as done"}
          className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-primary"
        />
        <div className={cn("min-w-0 flex-1 [&>p]:my-0", done && "text-muted-foreground")}>{children}</div>
      </li>
    );
  },
};

// Only real model replies carry the server's id; placeholders and error messages can't be rated
const ratableReply = (content: string): { id: string; handedOff: boolean } | null => {
  try {
    const reply = JSON.parse(content);
    if (typeof reply?.id !== "string" || !reply.response) return null;
    return { id: reply.id, handedOff: !!reply.redirect_to_agent?.should_redirect };
  } catch {
    return null;
  }
};

const StarterQuestionPrompts = ({
  questions,
  onSelect,
  disabled,
}: {
  questions: readonly string[];
  onSelect: (question: string) => void;
  disabled: boolean;
}) => (
  <div className="mt-8 w-full max-w-xl">
    <p className="text-sm font-medium text-foreground mb-3 text-center">Try asking</p>
    <ul className="flex flex-col gap-2" role="list">
      {questions.map((question) => (
        <li key={question}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onSelect(question)}
            className={cn(
              "group w-full flex items-center gap-3 rounded-lg border-2 border-border bg-card px-4 py-3 text-left text-sm font-normal text-foreground shadow-sm cursor-pointer transition-all",
              "hover:border-primary/50 hover:bg-accent hover:shadow-md active:scale-[0.99]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary group-hover:bg-primary/15"
              aria-hidden
            >
              <MessageSquare className="h-4 w-4" />
            </span>
            <span className="flex-1 leading-snug">{question}</span>
            <ChevronRight
              className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
              aria-hidden
            />
          </button>
        </li>
      ))}
    </ul>
    <p className="mt-2.5 text-center text-xs text-muted-foreground">
      Click a question to fill the message box below
    </p>
  </div>
);

const SuggestedQuestions = ({
  questions,
  onQuestionClick,
  isLoading,
}: {
  questions: string[];
  onQuestionClick: (question: string) => void;
  isLoading: boolean;
}) => {
  if (!questions || questions.length === 0) return null;

  return (
    <div className="mt-2 pl-10">
      {questions.map((question, index) => (
        <Button
          key={index}
          className="text-sm mb-2 mr-2 ml-0 text-gray-500 shadow-sm"
          variant="outline"
          size="sm"
          onClick={() => onQuestionClick(question)}
          disabled={isLoading}
        >
          {question}
        </Button>
      ))}
    </div>
  );
};

const MessageContent = ({
  content,
  role,
  handoff,
  onRequestHandoff,
  steps,
}: {
  content: string;
  role: string;
  handoff?: HandoffState;
  onRequestHandoff?: () => void;
  steps?: StepChecklist; // set on answers the customer can work through
}) => {
  const [thinking, setThinking] = useState(true);
  const [parsed, setParsed] = useState<{
    response?: string;
    thinking?: string;
    user_mood?: string;
    suggested_questions?: string[];
    redirect_to_agent?: { should_redirect: boolean; reason: string };
    debug?: {
      context_used: boolean;
    };
  }>({});
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!content || role !== "assistant") return;

    const timer = setTimeout(() => {
      setError(true);
      setThinking(false);
    }, 30000);

    try {
      const result = JSON.parse(content);
      console.log("🔍 Parsed Result:", result);

      if (
        result.response &&
        result.response.length > 0 &&
        result.response !== "..."
      ) {
        setParsed(result);
        setThinking(false);
        clearTimeout(timer);
      }
    } catch (error) {
      console.error("Error parsing JSON:", error);
      setError(true);
      setThinking(false);
    }

    return () => clearTimeout(timer);
  }, [content, role]);

  if (thinking && role === "assistant") {
    return (
      <div className="flex items-center">
        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-900 mr-2" />
        <span>Thinking...</span>
      </div>
    );
  }

  if (error && !parsed.response) {
    return <div>Something went wrong. Please try again.</div>;
  }

  return (
    <>
      <StepsContext.Provider value={steps ?? null}>
        <ReactMarkdown
          rehypePlugins={[rehypeRaw, rehypeHighlight]}
          components={steps ? checklistComponents : undefined}
        >
          {parsed.response || content}
        </ReactMarkdown>
      </StepsContext.Provider>
      {parsed.redirect_to_agent && (
        <UISelector
          redirectToAgent={parsed.redirect_to_agent}
          handoff={handoff}
          onRequestHandoff={onRequestHandoff}
        />
      )}
    </>
  );
};

interface Message {
  id: string;
  role: string;
  content: string;
}

// What this browser may do, from GET /api/session (the server enforces the same rules)
type SessionInfo = {
  owner: boolean;
  models: Pick<ChatModel, "id" | "name">[];
  maxMessageChars: number;
  remaining: number | null;
  dailyLimit: number | null;
};

// Until /api/session answers, assume the most restrictive (public) settings
const PUBLIC_SESSION: SessionInfo = {
  owner: false,
  models: MODELS.filter((m) => m.id === DEFAULT_MODEL_ID),
  maxMessageChars: 500,
  remaining: null,
  dailyLimit: 10,
};

// The knowledge base is chosen on the server (KNOWLEDGE_BASE_ID), so only the model is selectable here.
interface ConversationHeaderProps {
  selectedModel: string;
  setSelectedModel: (modelId: string) => void;
  models: Pick<ChatModel, "id" | "name">[];
  showAvatar: boolean;
  session: SessionInfo;
  leading?: React.ReactNode; // shown on the left of the row (the handoff policy button)
}

const ConversationHeader: React.FC<ConversationHeaderProps> = ({
  selectedModel,
  setSelectedModel,
  models,
  showAvatar,
  session,
  leading,
}) => (
  <div className="p-0 flex flex-col sm:flex-row items-start sm:items-center justify-between pb-2 animate-fade-in">
    <div className="flex items-center space-x-4 mb-2 sm:mb-0">
      {showAvatar && (
        <>
          <BotAvatar className="w-10 h-10" />
          <div>
            <h3 className="text-sm font-medium leading-none">AI Agent</h3>
            <p className="text-sm text-muted-foreground">Customer support</p>
          </div>
        </>
      )}
      {leading}
    </div>
    <div className="flex items-center gap-2 w-full sm:w-auto">
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {session.owner
          ? "Owner mode"
          : session.remaining !== null && session.dailyLimit !== null
            ? `Demo · ${session.remaining} of ${session.dailyLimit} questions left today`
            : "Demo mode"}
      </span>
      {models.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="flex-grow text-muted-foreground sm:flex-grow-0"
            >
              {models.find((m) => m.id === selectedModel)?.name}
              <ChevronDown className="ml-2 h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {models.map((model) => (
              <DropdownMenuItem
                key={model.id}
                onSelect={() => setSelectedModel(model.id)}
              >
                {model.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span className="text-xs text-muted-foreground border rounded-md px-2 py-1">
          {models[0]?.name}
        </span>
      )}
    </div>
  </div>
);

function ChatArea() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showHeader, setShowHeader] = useState(false);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL_ID);
  const [showAvatar, setShowAvatar] = useState(false);
  const [session, setSession] = useState<SessionInfo>(PUBLIC_SESSION);
  const [escalationLevel, setEscalationLevel] = useState<EscalationLevel>(DEFAULT_ESCALATION_LEVEL);
  const [policyOpen, setPolicyOpen] = useState(false); // handoff policy panel, closed by default
  const [retried, setRetried] = useState<Record<string, true>>({}); // reply ids where "Try again" was used
  const [pendingRetryOf, setPendingRetryOf] = useState<string | null>(null); // "Rephrase" waiting to be sent
  // Keyed by the id of the assistant message whose "Talk to a human" button was clicked
  const [handoffs, setHandoffs] = useState<Record<string, HandoffState>>({});

  // Keyed by the server's reply id, which is what the outcome is stored against
  const [outcomes, setOutcomes] = useState<Record<string, OutcomeState>>({});
  // Ticked step lines, keyed by the assistant message id
  const [checkedSteps, setCheckedSteps] = useState<Record<string, number[]>>({});

  const toggleStep = (messageId: string, line: number) =>
    setCheckedSteps((s) => {
      const current = s[messageId] ?? [];
      return {
        ...s,
        [messageId]: current.includes(line) ? current.filter((l) => l !== line) : [...current, line],
      };
    });

  const stepProgress = (message: Message) => {
    let total = 0;
    try {
      total = countSteps(JSON.parse(message.content).response ?? "");
    } catch {}
    return { done: Math.min((checkedSteps[message.id] ?? []).length, total), total };
  };

  const reportOutcome = async (
    replyId: string,
    result: OutcomeResult,
    reason: StuckReason | null,
    steps: { done: number; total: number },
    escalated = false,
  ) => {
    setOutcomes((o) => ({ ...o, [replyId]: { result, reason, status: "saving" } }));
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: replyId,
          result,
          reason,
          steps_done: steps.done,
          steps_total: steps.total,
          escalated,
        }),
      });
      if (!response.ok) throw new Error(`Feedback failed with status ${response.status}`);
      setOutcomes((o) => ({ ...o, [replyId]: { result, reason, status: "saved" } }));
    } catch (error) {
      console.error("Outcome not saved:", error);
      setOutcomes((o) => ({ ...o, [replyId]: { result, reason, status: "error" } }));
    }
  };

  // history: the conversation up to and including the assistant message that handed off.
  // stuck: set when the customer said the answer didn't fix it and asked for a person.
  // Returns whether a ticket was opened.
  const requestHandoff = async (
    messageId: string,
    history: Message[],
    stuck?: { reason: StuckReason | null; steps_done: number; steps_total: number },
  ): Promise<boolean> => {
    setHandoffs((h) => ({ ...h, [messageId]: { status: "loading" } }));
    try {
      const response = await fetch("/api/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map(({ role, content }) => ({ role, content })),
          ...(stuck ? { stuck } : {}),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ticket) {
        throw new Error(data.error || "Couldn't reach an agent. Please try again.");
      }
      setHandoffs((h) => ({
        ...h,
        [messageId]: { status: "done", ticket: data.ticket, stored: !!data.stored },
      }));
      return true;
    } catch (error) {
      setHandoffs((h) => ({
        ...h,
        [messageId]: {
          status: "error",
          message: error instanceof Error ? error.message : "Couldn't reach an agent. Please try again.",
        },
      }));
      return false;
    }
  };

  const talkToPersonAfterStuck = async (message: Message, index: number, replyId: string) => {
    const steps = stepProgress(message);
    const reason = outcomes[replyId]?.reason ?? null;
    const opened = await requestHandoff(message.id, messages.slice(0, index + 1), {
      reason,
      steps_done: steps.done,
      steps_total: steps.total,
    });
    if (opened) reportOutcome(replyId, "stuck", reason, steps, true);
  };

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch("/api/session", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: SessionInfo | null) => {
        if (!s) return;
        setSession(s);
        if (!s.models.some((m) => m.id === selectedModel) && s.models[0]) {
          setSelectedModel(s.models[0].id);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const outOfQuestions = !session.owner && session.remaining === 0;

  useEffect(() => {
    console.log("🔍 Messages changed! Count:", messages.length);

    const scrollToNewestMessage = () => {
      if (messagesEndRef.current) {
        console.log("📜 Scrolling to newest message...");
        const behavior = messages.length <= 2 ? "auto" : "smooth";
        messagesEndRef.current.scrollIntoView({ behavior, block: "end" });
      } else {
        console.log("❌ No scroll anchor found!");
      }
    };

    if (messages.length > 0) {
      setTimeout(scrollToNewestMessage, 100);
    }
  }, [messages]);

  useEffect(() => {
    if (!config.includeLeftSidebar) {
      // If LeftSidebar is not included, we need to handle the 'updateSidebar' event differently
      const handleUpdateSidebar = (event: CustomEvent<ThinkingContent>) => {
        console.log("LeftSidebar not included. Event data:", event.detail);
        // You might want to handle this data differently when LeftSidebar is not present
      };

      window.addEventListener(
        "updateSidebar" as any,
        handleUpdateSidebar as EventListener,
      );
      return () =>
        window.removeEventListener(
          "updateSidebar" as any,
          handleUpdateSidebar as EventListener,
        );
    }
  }, []);

  useEffect(() => {
    if (!config.includeRightSidebar) {
      // If RightSidebar is not included, we need to handle the 'updateRagSources' event differently
      const handleUpdateRagSources = (event: CustomEvent) => {
        console.log("RightSidebar not included. RAG sources:", event.detail);
        // You might want to handle this data differently when RightSidebar is not present
      };

      window.addEventListener(
        "updateRagSources" as any,
        handleUpdateRagSources as EventListener,
      );
      return () =>
        window.removeEventListener(
          "updateRagSources" as any,
          handleUpdateRagSources as EventListener,
        );
    }
  }, []);

  const decodeDebugData = (response: Response) => {
    const debugData = response.headers.get("X-Debug-Data");
    if (debugData) {
      try {
        const parsed = JSON.parse(debugData);
        console.log("🔍 Server Debug:", parsed.msg, parsed.data);
      } catch (e) {
        console.error("Debug decode failed:", e);
      }
    }
  };

  const logDuration = (label: string, duration: number) => {
    console.log(`⏱️ ${label}: ${duration.toFixed(2)}ms`);
  };

  // retryOf: id of the stuck reply whose "Try again" sent this message (also picked up from a
  // pending "Rephrase my question" when the customer sends the filled-in box)
  const handleSubmit = async (
    event: React.FormEvent<HTMLFormElement> | string,
    retryOf?: string,
  ) => {
    const retryOfId = retryOf ?? (typeof event === "string" ? undefined : pendingRetryOf ?? undefined);
    setPendingRetryOf(null);
    if (typeof event !== "string") {
      event.preventDefault();
    }
    if (!showHeader) setShowHeader(true);
    if (!showAvatar) setShowAvatar(true);
    setIsLoading(true);

    const clientStart = performance.now();
    console.log("🔄 Starting request: " + new Date().toISOString());

    const userMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: typeof event === "string" ? event : input,
    };

    const placeholderMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: JSON.stringify({
        response: "",
        thinking: "AI is processing...",
        user_mood: "neutral",
        debug: {
          context_used: false,
        },
      }),
    };

    setMessages((prevMessages) => [
      ...prevMessages,
      userMessage,
      placeholderMessage,
    ]);
    setInput("");

    const placeholderDisplayed = performance.now();
    logDuration("Perceived Latency", placeholderDisplayed - clientStart);

    try {
      console.log("➡️ Sending message to API:", userMessage.content);
      const startTime = performance.now();
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...messages, userMessage].map(({ role, content }) => ({
            role,
            content,
          })),
          model: selectedModel,
          escalation_level: escalationLevel,
          ...(retryOfId ? { retry_of: retryOfId } : {}),
        }),
      });

      const responseReceived = performance.now();
      logDuration("Full Round Trip", responseReceived - startTime);

      decodeDebugData(response);

      // Error responses still carry a user-facing `response` message; show it instead of a spinner.
      const data = await response.json().catch(() => ({}));
      if (
        (response.ok || response.status === 429) &&
        typeof data?.limits?.remaining === "number"
      ) {
        setSession((s) => ({ ...s, remaining: data.limits.remaining }));
      }
      if (!response.ok || !data.response) {
        throw new Error(
          data.response || `API request failed with status ${response.status}`,
        );
      }
      console.log("⬅️ Received response from API:", data);

      const sources = Array.isArray(data.rag_sources) ? data.rag_sources : [];
      if (sources.length > 0) {
        window.dispatchEvent(
          new CustomEvent("updateRagSources", {
            detail: {
              sources,
              query: userMessage.content,
              debug: data.debug,
            },
          }),
        );
      }

      const readyToRender = performance.now();
      logDuration("Response Processing", readyToRender - responseReceived);

      // Sources go to the sidebar only; keep them out of the stored (and re-sent) history
      const { rag_sources: _sources, ...reply } = data;
      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: JSON.stringify(reply),
      };
      setMessages((prevMessages) => {
        const newMessages = [...prevMessages];
        newMessages[newMessages.length - 1] = assistantMessage;
        return newMessages;
      });
      if (data.redirect_to_agent?.should_redirect) {
        requestHandoff(assistantMessage.id, [...messages, userMessage, assistantMessage]);
      }

      const sidebarEvent = new CustomEvent("updateSidebar", {
        detail: {
          id: data.id,
          content: data.thinking?.trim(),
          user_mood: data.user_mood,
          debug: data.debug,
          matched_categories: data.matched_categories,
        },
      });
      window.dispatchEvent(sidebarEvent);

      if (data.redirect_to_agent && data.redirect_to_agent.should_redirect) {
        window.dispatchEvent(
          new CustomEvent("agentRedirectRequested", {
            detail: data.redirect_to_agent,
          }),
        );
      }
    } catch (error) {
      console.error("Error fetching chat response:", error);
      const message =
        error instanceof Error && !error.message.startsWith("API request failed")
          ? error.message
          : "Sorry, something went wrong. Please try again.";
      setMessages((prevMessages) => {
        const newMessages = [...prevMessages];
        newMessages[newMessages.length - 1] = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: JSON.stringify({ response: message, suggested_questions: [] }),
        };
        return newMessages;
      });
    } finally {
      setIsLoading(false);
      const clientEnd = performance.now();
      logDuration("Total Client Operation", clientEnd - clientStart);
    }
  };

  const resizeTextarea = (textarea: HTMLTextAreaElement) => {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 300)}px`;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (input.trim() !== "") {
        handleSubmit(e as any);
      }
    }
  };

  const handleInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const textarea = event.target;
    setInput(textarea.value);
    resizeTextarea(textarea);
  };

  const handleSuggestedQuestionClick = (question: string) => {
    if (outOfQuestions) return;
    handleSubmit(question.slice(0, session.maxMessageChars));
  };

  // Put text in the message box and leave the cursor at its end, ready to edit or send
  const fillInput = (text: string) => {
    const value = text.slice(0, session.maxMessageChars);
    setInput(value);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      resizeTextarea(textarea);
      textarea.focus();
      textarea.setSelectionRange(value.length, value.length);
    });
  };

  const handleStarterQuestionClick = (question: string) => {
    if (outOfQuestions || isLoading) return;
    fillInput(question);
  };

  // "Try again" under a stuck reply: send the reason-worded follow-up, or fill the box to rephrase
  const tryAgain = (replyId: string, reason: StuckReason) => {
    if (outOfQuestions || isLoading) return;
    setRetried((r) => ({ ...r, [replyId]: true }));
    if (reason === RETRY_FILLS_INPUT) {
      setPendingRetryOf(replyId);
      fillInput(RETRY_MESSAGES[reason]);
    } else {
      handleSubmit(RETRY_MESSAGES[reason], replyId);
    }
  };

  return (
    <Card className="flex-1 flex flex-col mb-4 mr-4 ml-4">
      <CardContent className="flex-1 flex flex-col overflow-hidden pt-4 px-4 pb-0">
        <ConversationHeader
          selectedModel={selectedModel}
          setSelectedModel={setSelectedModel}
          models={session.models}
          showAvatar={showAvatar}
          session={session}
          leading={
            <PolicyToggle value={escalationLevel} expanded={policyOpen} onToggle={() => setPolicyOpen((o) => !o)} />
          }
        />
        <PolicySelector
          value={escalationLevel}
          onChange={setEscalationLevel}
          disabled={isLoading}
          expanded={policyOpen}
        />
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full animate-fade-in-up">
              <BotAvatar className="w-10 h-10 mb-4" />
              <h2 className="text-2xl font-semibold mb-8">
                Here&apos;s how I can help
              </h2>
              <div className="space-y-4 text-sm">
                <div className="flex items-center gap-3">
                  <HandHelping className="text-muted-foreground" />
                  <p className="text-muted-foreground">
                    Need guidance? I&apos;ll help navigate tasks using internal
                    resources.
                  </p>
                </div>
              </div>
              <StarterQuestionPrompts
                questions={STARTER_QUESTIONS}
                onSelect={handleStarterQuestionClick}
                disabled={isLoading || outOfQuestions}
              />
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((message, index) => (
                <div key={message.id}>
                  <div
                    className={`flex items-start ${
                      message.role === "user" ? "justify-end" : ""
                    } ${
                      index === messages.length - 1 ? "animate-fade-in-up" : ""
                    }`}
                    style={{
                      animationDuration: "300ms",
                      animationFillMode: "backwards",
                    }}
                  >
                    {message.role === "assistant" && (
                      <BotAvatar className="w-8 h-8 mr-2" iconClassName="w-4 h-4" />
                    )}
                    <div
                      className={`p-3 rounded-md text-sm max-w-[65%] ${
                        message.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted border"
                      }`}
                    >
                      <MessageContent
                        content={message.content}
                        role={message.role}
                        handoff={handoffs[message.id]}
                        onRequestHandoff={() =>
                          requestHandoff(message.id, messages.slice(0, index + 1))
                        }
                        steps={
                          (() => {
                            const reply = message.role === "assistant" ? ratableReply(message.content) : null;
                            return reply && !reply.handedOff
                              ? {
                                  checked: checkedSteps[message.id] ?? [],
                                  toggle: (line: number) => toggleStep(message.id, line),
                                }
                              : undefined;
                          })()
                        }
                      />
                    </div>
                  </div>
                  {message.role === "assistant" &&
                    (() => {
                      const reply = ratableReply(message.content);
                      if (!reply) return null;
                      const steps = stepProgress(message);
                      return (
                        <ReplyOutcome
                          handedOff={reply.handedOff}
                          outcome={outcomes[reply.id]}
                          steps={steps}
                          handoff={reply.handedOff ? undefined : handoffs[message.id]}
                          onReport={(result, reason) =>
                            reportOutcome(
                              reply.id,
                              result,
                              reason,
                              steps,
                              // keep the escalation on record if the reason is changed after the ticket opened
                              result === "stuck" && handoffs[message.id]?.status === "done",
                            )
                          }
                          onTalkToPerson={() => talkToPersonAfterStuck(message, index, reply.id)}
                          canRetry={index === messages.length - 1 && !isLoading && !outOfQuestions}
                          retried={!!retried[reply.id]}
                          onTryAgain={(reason) => tryAgain(reply.id, reason)}
                        />
                      );
                    })()}
                  {message.role === "assistant" && (
                    <SuggestedQuestions
                      questions={
                        JSON.parse(message.content).suggested_questions || []
                      }
                      onQuestionClick={handleSuggestedQuestionClick}
                      isLoading={isLoading}
                    />
                  )}
                </div>
              ))}
              <div ref={messagesEndRef} style={{ height: "1px" }} />
            </div>
          )}
        </div>
      </CardContent>

      <CardFooter className="p-4 pt-0">
        <form
          onSubmit={handleSubmit}
          className="flex flex-col w-full relative bg-background border rounded-xl focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2"
        >
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={
              outOfQuestions
                ? "You've used today's demo questions. Please come back tomorrow."
                : "Type your message here..."
            }
            disabled={isLoading || outOfQuestions}
            maxLength={session.maxMessageChars}
            className="resize-none min-h-[44px] bg-background  border-0 p-3 rounded-xl shadow-none focus-visible:ring-0"
            rows={1}
          />
          <div className="flex justify-between items-center p-3">
            <span className="text-xs text-muted-foreground">
              Questions and feedback kept for 30 days
              {!session.owner && (
                <span className="ml-2">
                  · {input.length}/{session.maxMessageChars}
                </span>
              )}
            </span>
            <Button
              type="submit"
              disabled={isLoading || outOfQuestions || input.trim() === ""}
              className="gap-2"
              size="sm"
            >
              {isLoading ? (
                <div className="animate-spin h-5 w-5 border-t-2 border-white rounded-full" />
              ) : (
                <>
                  Send Message
                  <Send className="h-4 w-4" />
                </>
              )}
            </Button>
          </div>
        </form>
      </CardFooter>
    </Card>
  );
}

export default ChatArea;
