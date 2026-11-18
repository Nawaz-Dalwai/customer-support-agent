"use client";

import { useEffect, useRef, useState } from "react";
import config from "@/config";
import { MODELS, DEFAULT_MODEL_ID, type ChatModel } from "@/app/lib/models";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import {
  HandHelping,
  WandSparkles,
  LifeBuoyIcon,
  BookOpenText,
  ChevronDown,
  Send,
  Bot,
  CircleCheck,
} from "lucide-react";
import type { HandoffTicket } from "@/app/lib/handoff";
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
}: {
  content: string;
  role: string;
  handoff?: HandoffState;
  onRequestHandoff?: () => void;
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
      <ReactMarkdown rehypePlugins={[rehypeRaw, rehypeHighlight]}>
        {parsed.response || content}
      </ReactMarkdown>
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
}

const ConversationHeader: React.FC<ConversationHeaderProps> = ({
  selectedModel,
  setSelectedModel,
  models,
  showAvatar,
  session,
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
  // Keyed by the id of the assistant message whose "Talk to a human" button was clicked
  const [handoffs, setHandoffs] = useState<Record<string, HandoffState>>({});

  // history: the conversation up to and including the assistant message that handed off
  const requestHandoff = async (messageId: string, history: Message[]) => {
    setHandoffs((h) => ({ ...h, [messageId]: { status: "loading" } }));
    try {
      const response = await fetch("/api/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map(({ role, content }) => ({ role, content })),
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
    } catch (error) {
      setHandoffs((h) => ({
        ...h,
        [messageId]: {
          status: "error",
          message: error instanceof Error ? error.message : "Couldn't reach an agent. Please try again.",
        },
      }));
    }
  };

  const messagesEndRef = useRef<HTMLDivElement>(null);

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

  const handleSubmit = async (
    event: React.FormEvent<HTMLFormElement> | string,
  ) => {
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
        }),
      });

      const responseReceived = performance.now();
      logDuration("Full Round Trip", responseReceived - startTime);

      decodeDebugData(response);

      // Error responses still carry a user-facing `response` message; show it instead of a spinner.
      const data = await response.json().catch(() => ({}));
      if (typeof data?.limits?.remaining === "number") {
        const left = data.limits.remaining;
        setSession((s) => ({ ...s, remaining: left }));
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

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 300)}px`;
  };

  const handleSuggestedQuestionClick = (question: string) => {
    if (outOfQuestions) return;
    handleSubmit(question.slice(0, session.maxMessageChars));
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
                <div className="flex items-center gap-3">
                  <WandSparkles className="text-muted-foreground" />
                  <p className="text-muted-foreground">
                    I&apos;m a whiz at finding information! I can dig through
                    your knowledge base.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <BookOpenText className="text-muted-foreground" />
                  <p className="text-muted-foreground">
                    I&apos;m always learning! The more you share, the better I
                    can assist you.
                  </p>
                </div>
              </div>
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
                      />
                    </div>
                  </div>
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
              Powered by Claude
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
