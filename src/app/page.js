"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Image from "next/image";
import { ArrowUp, Check, Copy } from "lucide-react";
import MarkdownMessage from "../components/MarkdownMessage";
import mandiLogo from "@public/favicon.png";

const PROMPT_SUGGESTIONS = [
  "Where are apples the cheapest today?",
  "Compare potato prices across Tamil Nadu and Kerala",
  "What's the average price of onions in Gujarat?",
  "Which market has the highest wheat prices?",
];

const WELCOME_MESSAGE = {
  role: "assistant",
  isIntro: true,
  content: `**Ask Mandi** uses open data by the Govt of India to give you access to commodity prices like tomatoes, onions, potatoes & more from 900+ agricultural markets across India.

Whether you're a farmer checking today's rates, a trader comparing prices across states, or just curious about market trends ask in plain language and get answers in seconds.`,
};

const toPlainText = (input) => {
  const src = String(input ?? "");
  return src
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/!\[([^\]]*)\]\((.*?)\)/g, "$1 ($2)")
    .replace(/\[([^\]]+)\]\((.*?)\)/g, "$1 ($2)")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const writeClipboard = async (text) => {
  if (!text) return false;
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.error("Failed to copy text", err);
    return false;
  }
};

export default function Home() {
  const [messages, setMessages] = useState([WELCOME_MESSAGE]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [isMultiline, setIsMultiline] = useState(false);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const streamDraftRef = useRef("");
  const streamFlushTimerRef = useRef(null);
  const lastScrollAtRef = useRef(0);

  const scrollToBottom = useCallback((behavior = "auto") => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  useEffect(() => {
    // Smooth scroll only when a full message is appended; streaming updates are throttled.
    if (!streamingContent) {
      scrollToBottom("smooth");
      return;
    }

    const now = Date.now();
    if (now - lastScrollAtRef.current > 120) {
      lastScrollAtRef.current = now;
      scrollToBottom("auto");
    }
  }, [messages, streamingContent, scrollToBottom]);

  const syncTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;

    el.style.height = "auto";
    const maxHeight = 192;
    const nextHeight = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${nextHeight}px`;

    setIsMultiline(el.scrollHeight > 48);
  };

  const parseSseBuffer = (buffer, handlers) => {
    let remaining = buffer;
    let index;
    while ((index = remaining.indexOf("\n\n")) !== -1) {
      const rawEvent = remaining.slice(0, index).trim();
      remaining = remaining.slice(index + 2);
      if (!rawEvent) continue;

      let eventType = "delta";
      let dataPayload = "";

      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataPayload += line.slice(5).trim();
        }
      }

      if (!dataPayload) continue;

      try {
        const parsed = JSON.parse(dataPayload);
        handlers(eventType, parsed);
      } catch (err) {
        console.error("Failed to parse SSE payload", err);
      }
    }
    return remaining;
  };

  const sendMessage = async (content) => {
    if (!content.trim() || isLoading) return;

    const userMessage = { role: "user", content: content.trim() };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setIsLoading(true);
    setIsMultiline(false);
    setStreamingContent("");
    streamDraftRef.current = "";
    if (streamFlushTimerRef.current) {
      clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    try {
      const apiMessages = newMessages
        .filter((m) => !m?.isIntro)
        .map(({ role, content }) => ({ role, content }));

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages }),
      });

      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("text/event-stream")) {
        if (!response.ok) {
          // Best-effort parse of JSON error body for non-2xx responses.
          let errMsg = `Request failed (${response.status})`;
          try {
            const data = await response.json();
            errMsg = data?.error || data?.details || errMsg;
          } catch {}
          throw new Error(errMsg);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("Streaming not supported in this browser");
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let streamError = null;

        const handleEvent = (eventType, payload) => {
          if (eventType === "delta" && payload?.delta) {
            streamDraftRef.current += payload.delta;
            if (!streamFlushTimerRef.current) {
              streamFlushTimerRef.current = setTimeout(() => {
                setStreamingContent(streamDraftRef.current);
                streamFlushTimerRef.current = null;
              }, 50);
            }
          } else if (eventType === "done") {
            const finalText = payload?.fullText || "";
            const usage = payload?.usage || null;
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                content: finalText,
                usage,
              },
            ]);
            streamDraftRef.current = "";
            setStreamingContent("");
          } else if (eventType === "error") {
            streamError = new Error(payload?.message || "Stream error");
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          buffer = parseSseBuffer(buffer, handleEvent);
          if (streamError) break;
        }

        if (buffer && !streamError) {
          buffer = parseSseBuffer(buffer, handleEvent);
        }

        if (streamError) {
          throw streamError;
        }
      } else {
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || "Failed to get response");
        }
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: data.message || "Something went wrong.",
            usage: data.usage || null,
          },
        ]);
      }
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Sorry, something went wrong: ${error.message}`,
          usage: null,
        },
      ]);
      streamDraftRef.current = "";
      setStreamingContent("");
    } finally {
      if (streamFlushTimerRef.current) {
        clearTimeout(streamFlushTimerRef.current);
        streamFlushTimerRef.current = null;
      }
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
    <div className="flex min-h-dvh flex-col bg-background font-sans text-foreground">
      {/* Header with progressive blur */}
      <header className="sticky top-0 z-10">
        <div className="absolute inset-0 bg-linear-to-b from-black via-black/95 to-transparent pointer-events-none" />
        <div className="absolute inset-0 backdrop-blur-xl mask-[linear-gradient(to_bottom,black_50%,transparent_100%)] pointer-events-none" />
        <div className="relative mx-auto flex h-14 max-w-3xl items-center px-4">
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

            {streamingContent && (
              <div className="flex justify-start">
                <div className="max-w-[92%] md:max-w-[70%] space-y-2">
                  <div className="text-[11px] font-medium uppercase tracking-wide mb-0.5 text-zinc-500 ml-2">
                    Mandi AI
                  </div>
                  <div className="rounded-2xl border border-zinc-700/50 bg-zinc-900/60 px-4 py-3 text-sm leading-relaxed shadow-sm text-foreground flex items-center gap-2">
                    <MarkdownMessage
                      content={streamingContent}
                      variant="assistant"
                    />
                    <span className="inline-block w-2 h-4 bg-lime-500 animate-pulse rounded-full" />
                  </div>
                </div>
              </div>
            )}

            {/* Loading indicator */}
            {isLoading && !streamingContent && (
              <div className="flex justify-start">
                <div className="max-w-[92%] space-y-2">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                    Mandi AI
                  </div>
                  <div className="rounded-2xl border border-zinc-700/50 bg-user-bubble px-4 py-3 shadow-sm">
                    <div className="flex items-center gap-1">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-zinc-500" />
                      <span className="h-2 w-2 animate-pulse rounded-full bg-zinc-500 [animation-delay:150ms]" />
                      <span className="h-2 w-2 animate-pulse rounded-full bg-zinc-500 [animation-delay:300ms]" />
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
          <form onSubmit={handleSubmit} className="relative flex items-center">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                syncTextarea();
              }}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything about mandi prices..."
              rows={1}
              maxLength={200}
              className="w-full resize-none bg-zinc-900/80 border border-zinc-700/50 rounded-2xl backdrop-blur-sm px-4 py-3 pr-12 text-sm leading-relaxed placeholder:text-zinc-500 focus:border-lime-500/50 focus:outline-none focus:ring-1 focus:ring-lime-500/50 disabled:opacity-50 min-h-[48px] max-h-48"
              style={{
                scrollbarWidth: "none",
                msOverflowStyle: "none",
              }}
            />
            {input.trim().length > 0 && (
              <button
                type="submit"
                disabled={isLoading}
                className={`absolute right-2.5 flex h-8 w-8 items-center justify-center rounded-full bg-lime-500 text-background hover:opacity-90 disabled:opacity-30 ${
                  isMultiline ? "bottom-2.5" : "top-1/2 -translate-y-1/2"
                }`}
              >
                <ArrowUp className="h-5 w-5" />
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

  const handleCopy = useCallback(async () => {
    const plainText = toPlainText(message.content);
    const success = await writeClipboard(plainText);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  }, [message.content]);

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
              : "border-zinc-700/50 bg-zinc-900/60 text-foreground"
          }`}
        >
          <MarkdownMessage
            content={message.content}
            variant={isUser ? "user" : "assistant"}
          />
        </div>

        {/* Prompt suggestions for welcome message */}
        {isWelcome && (
          <div className="flex flex-wrap gap-2 pt-4">
            {PROMPT_SUGGESTIONS.map((suggestion, i) => (
              <button
                key={i}
                onClick={() => onSuggestionClick(suggestion)}
                className="rounded-xl border border-zinc-700/50 bg-zinc-900/60 px-3 py-1.5 text-left text-sm text-zinc-400 transition-colors hover:border-lime-500/80 hover:text-foreground hover:bg-zinc-900/80"
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
              onClick={handleCopy}
              className="inline-flex items-center gap-2 rounded-full border border-zinc-700/50 bg-zinc-900/80 px-3 py-1.5 text-xs text-zinc-400 hover:text-foreground"
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
              <div className="rounded-full border border-zinc-700/50 bg-zinc-900/80 px-3 py-1.5 text-xs text-zinc-400">
                {new Intl.NumberFormat().format(tokenCount)} tokens
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
