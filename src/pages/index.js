import { useState, useRef, useEffect } from "react";
import Image from "next/image";
import { ArrowUp, Check, Copy } from "lucide-react";
import MarkdownMessage from "../components/MarkdownMessage";
import mandiLogo from "@public/favicon.png";

const PROMPT_SUGGESTIONS = [
  "Where are tomatoes the cheapest today?",
  "Compare potato prices across Maharashtra and Kerala",
  "What's the average price of onions in Gujarat?",
  "Which market has the highest wheat prices?",
];

const WELCOME_MESSAGE = {
  role: "assistant",
  isIntro: true,
  content: `Welcome to **AskMandi**.

Ask questions like:
- "Where are tomatoes the cheapest today?"
- "Compare potato prices across Maharashtra and Kerala"
- "Which market has the highest wheat prices?"

Prices are in ₹/quintal (100 kg). I’ll convert to ₹/kg when helpful.`,
};

export default function Home() {
  const [messages, setMessages] = useState([WELCOME_MESSAGE]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isMultiline, setIsMultiline] = useState(false);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const syncTextarea = (nextValue = null) => {
    const el = textareaRef.current;
    if (!el) return;

    // Recompute height
    el.style.height = "auto";
    const maxHeight = 150;
    const nextHeight = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${nextHeight}px`;

    // Determine multiline (approx: > 1 line)
    setIsMultiline(el.scrollHeight > 52);
  };

  const sendMessage = async (content) => {
    if (!content.trim() || isLoading) return;

    const userMessage = { role: "user", content: content.trim() };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setIsLoading(true);
    setIsMultiline(false);

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    try {
      // Prepare messages for API (exclude welcome message)
      const apiMessages = newMessages
        .filter((m) => !m?.isIntro)
        .map(({ role, content }) => ({ role, content }));

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to get response");
      }

      if (process.env.NODE_ENV !== "production") {
        console.log("[askmandi] tokens", data.usage);
      }

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.message,
          usage: data.usage || null,
        },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Sorry, something went wrong: ${error.message}`,
          usage: null,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    sendMessage(input);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  return (
    <div
      className={`flex min-h-dvh flex-col bg-background font-sans text-foreground`}
    >
      {/* Header */}
      <header className="sticky top-0 z-10 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-3xl items-center px-4">
          <div className="flex items-center gap-3">
            <Image
              src={mandiLogo}
              alt="Ask Mandi logo"
              priority
              className="h-9 w-9 rounded-md border border-lime-950 bg-zinc-900/80 p-1"
            />
            <span className="text-2xl text-lime-200 font-semibold tracking-tight">
              Ask Mandi
            </span>
          </div>
        </div>
      </header>

      {/* Messages */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6">
          <div className="space-y-6">
            {messages.map((message, index) => (
              <Message
                key={index}
                message={message}
                isWelcome={Boolean(message?.isIntro)}
                onSuggestionClick={sendMessage}
              />
            ))}

            {isLoading && (
              <div className="flex justify-start">
                <div className="max-w-[92%] space-y-2">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
                    Mandi AI
                  </div>
                  <div className="rounded-2xl border border-border bg-user-bubble px-4 py-3 shadow-sm">
                    <div className="flex items-center gap-1">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-muted" />
                      <span className="h-2 w-2 animate-pulse rounded-full bg-muted [animation-delay:150ms]" />
                      <span className="h-2 w-2 animate-pulse rounded-full bg-muted [animation-delay:300ms]" />
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>
      </main>

      {/* Input */}
      <footer className="sticky bottom-0 bg-linear-to-t from-black via-black/95 to-transparent">
        <div className="mx-auto max-w-3xl px-4 pb-2">
          <form onSubmit={handleSubmit} className="relative">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                const v = e.target.value;
                setInput(v);
                syncTextarea(v);
              }}
              onKeyDown={handleKeyDown}
              placeholder="Ask about mandi prices..."
              disabled={isLoading}
              rows={1}
              className="w-full resize-none bg-zinc-900/80 border border-zinc-700/50 rounded-2xl backdrop-blur-sm px-4 py-3 pr-12 text-sm leading-relaxed placeholder:text-muted focus:border-lime-500/50 focus:outline-none focus:ring-1 focus:ring-lime-500/50 disabled:opacity-50"
              style={{ maxHeight: "150px" }}
            />
            {input.trim().length > 0 && (
              <button
                type="submit"
                disabled={isLoading}
                className={`absolute right-2.5 flex h-8 w-8 items-center justify-center rounded-lg bg-lime-500 text-background transition-opacity hover:opacity-90 disabled:opacity-30 ${
                  isMultiline ? "bottom-2.5" : "top-1/2 -translate-y-1/2"
                }`}
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            )}
          </form>
        </div>
      </footer>
    </div>
  );
}

function Message({ message, isWelcome = false, onSuggestionClick }) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  const tokenCount =
    typeof message?.usage?.totalTokens === "number"
      ? message.usage.totalTokens
      : null;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[92%] md:max-w-[70%]">
        <div
          className={`text-[11px] font-medium uppercase tracking-wide mb-0.5 ${
            isUser ? "text-zinc-500 text-right mr-2" : "text-zinc-500 ml-2"
          }`}
        >
          {isUser ? "You" : "Mandi AI"}
        </div>
        <div
          className={`rounded-2xl border px-4 py-3 text-sm leading-relaxed shadow-sm ${
            isUser
              ? "border-transparent bg-zinc-50 text-black"
              : "border-border bg-zinc-900/60 text-foreground"
          }`}
        >
          <MarkdownMessage
            content={message.content}
            variant={isUser ? "user" : "assistant"}
          />
        </div>

        {/* Prompt suggestions for welcome message */}
        {isWelcome && (
          <div className="flex flex-wrap gap-2 pt-2">
            {PROMPT_SUGGESTIONS.map((suggestion, i) => (
              <button
                key={i}
                onClick={() => onSuggestionClick(suggestion)}
                className="rounded-xl border border-zinc-700/50 bg-zinc-900/20 px-3 py-1.5 text-left text-xs text-zinc-400 transition-colors hover:border-lime-500/80 hover:text-foreground hover:bg-zinc-900/80"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}

        {/* Assistant actions */}
        {!isUser && !isWelcome && (
          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(message.content || "");
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                } catch {
                  console.warn("Copy failed");
                }
              }}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-zinc-900/80 px-3 py-1.5 text-xs text-zinc-400 hover:text-foreground"
              aria-label="Copy message"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copied ? "Copied" : "Copy"}
            </button>

            {typeof tokenCount === "number" && (
              <div className="rounded-full border border-border bg-zinc-900/80 px-3 py-1.5 text-xs text-zinc-400">
                {new Intl.NumberFormat().format(tokenCount)} tokens
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
