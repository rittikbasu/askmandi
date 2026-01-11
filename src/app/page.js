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

const QUOTA_KEY = "askmandi:quota";

function useRateLimit() {
  const [resetTime, setResetTime] = useState(() => {
    if (typeof window === "undefined") return null;
    try {
      const stored = localStorage.getItem(QUOTA_KEY);
      if (stored) {
        const { reset } = JSON.parse(stored);
        if (reset && reset > Date.now()) {
          return reset;
        } else {
          localStorage.removeItem(QUOTA_KEY);
        }
      }
    } catch {}
    return null;
  });

  const setQuota = (remaining, reset) => {
    if (typeof window === "undefined") return;
    try {
      if (remaining === 0) {
        // Fallback to 12h if no reset time provided
        const effectiveReset = reset || Date.now() + 12 * 60 * 60 * 1000;
        localStorage.setItem(
          QUOTA_KEY,
          JSON.stringify({ remaining, reset: effectiveReset })
        );
        setResetTime(effectiveReset);
      } else {
        localStorage.setItem(QUOTA_KEY, JSON.stringify({ remaining, reset }));
      }
    } catch {}
  };

  const clearQuota = () => {
    if (typeof window === "undefined") return;
    localStorage.removeItem(QUOTA_KEY);
    setResetTime(null);
  };

  return { isRateLimited: !!resetTime, resetTime, setQuota, clearQuota };
}

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

function formatTimeRemaining(resetTimestamp) {
  if (!resetTimestamp) return null;
  const diff = resetTimestamp - Date.now();
  if (diff <= 0) return null;

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return "a moment";
}

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

  const { isRateLimited, resetTime, setQuota, clearQuota } = useRateLimit();

  const scrollToBottom = useCallback((behavior = "auto") => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  useEffect(() => {
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

    // Check rate limit from localStorage first
    if (isRateLimited) {
      const timer = formatTimeRemaining(resetTime);
      if (!timer) {
        // Timer expired, clear and proceed
        clearQuota();
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "user", content: content.trim() },
          {
            role: "assistant",
            content: `You've reached the limit of 10 questions. Please try again in ${timer}.`,
            usage: null,
          },
        ]);
        setInput("");
        return;
      }
    }

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

      const requestStartTime = performance.now();
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
        let ttft = null;

        const handleEvent = (eventType, payload) => {
          if (eventType === "delta" && payload?.delta) {
            // Record time to first token
            if (ttft === null) {
              ttft = Math.round(performance.now() - requestStartTime);
            }
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
            // Update quota from backend
            if (typeof payload?.remaining === "number") {
              setQuota(payload.remaining);
            }
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                content: finalText,
                usage,
                ttft,
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
          // Handle rate limit error
          if (response.status === 429) {
            setQuota(0, data.reset);
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                content: data.error || "Rate limit reached. Please try again later.",
                usage: null,
              },
            ]);
            return;
          }
          throw new Error(data.error || "Failed to get response");
        }
        // Update quota (skip for cached responses)
        if (typeof data.remaining === "number" && !data.cached) {
          setQuota(data.remaining);
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
  const ttft = typeof message?.ttft === "number" ? message.ttft : null;

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
          <div className="pt-4">
            <div className="flex flex-wrap gap-2">
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

            <div className="mt-4 ml-1 inline-flex items-center text-sm text-zinc-400">
              <a
                href="https://rittik.io"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 group hover:text-gray-200 transition-colors"
                aria-label="Visit rittik.io"
              >
                made with
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 650 900"
                  className="inline-block h-[0.95em] align-middle text-red-500 group-hover:text-red-800 transition-colors"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path
                    fill="currentColor"
                    d="M636.688 17.688c9.097 8.478 13.182 19.131 13.78 31.449q.052 3.275.032 6.55l-.02 3.574c-.221 10.872-2 20.993-4.663 31.509a693 693 0 0 0-2.508 10.355c-4.767 19.676-10.971 38.79-17.623 57.9q-.942 2.716-1.877 5.433c-5.664 16.406-12.1 32.492-18.597 48.58a12541 12541 0 0 0-13.962 34.774l-1.43 3.575a7169 7169 0 0 0-32.316 82.254q-2.313 5.993-4.629 11.984l-1.166 3.018c-6.835 17.672-13.843 35.272-20.896 52.857-9.924 24.73-9.924 24.73-19.714 49.514q-.938 2.394-1.88 4.787c-9.189 23.333-17.276 47.007-24.719 70.949a13841 13841 0 0 1-5.303 16.93 2597 2597 0 0 1-8.869 27.742c-29.296 89.995-50.892 182.234-76.068 306.099l-.383 2.32a357 357 0 0 0-.699 4.438c-.93 5.655-2.754 9.99-7.178 13.721-4.482 2.74-8.894 2.842-14 2-13.325-5.971-22.214-19.556-27.273-32.71-4.679-14.74-.933-30.477 2.273-45.102q.612-2.89 1.219-5.78a1536 1536 0 0 1 6.16-27.787l.564-2.462c.868-3.793 1.75-7.58 2.668-11.361 3.14-13.244 4.537-23.827-2.611-35.798-2.327-2.953-4.913-5.56-7.6-8.184l-2.27-2.276a1404 1404 0 0 0-7.4-7.333 4724 4724 0 0 0-18.765-18.643 4890 4890 0 0 1-11.057-10.997q-6.616-6.591-13.24-13.172l-2.53-2.515q-3.57-3.546-7.149-7.084l-2.1-2.086a233 233 0 0 0-12.093-11.132c-3.466-3.045-6.642-6.383-9.862-9.683-2.76-2.8-5.565-5.47-8.555-8.024-5.344-4.62-10.296-9.639-15.28-14.64q-2.489-2.496-4.988-4.983c-5.03-5.028-9.962-10.09-14.583-15.502-2.532-2.894-5.28-5.56-8.028-8.246-4.016-3.972-7.904-7.97-11.563-12.277-2.739-3.143-5.592-6.177-8.437-9.223-4.591-4.926-9.123-9.882-13.5-15l-2.629-3.066a4355 4355 0 0 1-4.545-5.309 1000 1000 0 0 0-8.103-9.371c-5.68-6.485-11.214-13.03-16.491-19.848-3.627-4.676-7.384-9.233-11.17-13.781-5.501-6.634-10.747-13.412-15.87-20.34a589 589 0 0 0-7.04-9.289c-7.729-10.023-15.149-20.166-22.215-30.668a280 280 0 0 0-6.63-9.403C38.375 378.39-9.2 294.742 1.25 219.687c2.285-14.744 7.287-28.009 19.121-37.78 24.183-17.536 55.376-22.038 84.504-17.782C142.918 170.226 180.703 185.689 210 211l2.398 2.066c9.565 8.434 18.506 17.29 26.45 27.274 2.88 3.56 5.943 6.933 9.027 10.316 1.95 2.15 3.855 4.332 5.75 6.531 2.746 3.157 5.639 6.104 8.629 9.028 1.833 1.874 3.501 3.837 5.183 5.848 3.42 3.985 7.276 6.945 11.563 9.937 5.874-7.658 10.022-15.825 14-24.563l1.948-4.21a2327 2327 0 0 0 9.939-21.852c20.637-45.87 45.972-88.724 80-126.043a296 296 0 0 0 5.55-6.332c4.273-4.91 8.93-9.434 13.563-14a980 980 0 0 0 8.602-8.672c28.337-28.805 63.28-41.968 99.946-57.302a6557 6557 0 0 0 7.131-2.99 1963 1963 0 0 1 10.87-4.517 914 914 0 0 0 3.931-1.634c31.982-13.36 73.796-15.592 102.207 7.803Zm-214.25 98.183c-2.208 2.667-4.331 5.382-6.438 8.129l-3.043 3.855C384.373 164.3 366.091 207.273 349 250l-.779 1.947c-19.813 49.689-30.968 91.015-21.526 144.516 1.975 11.208 3.516 22.41 4.743 33.724l.252 2.315q.677 6.246 1.31 12.498-1.921 1.229-3.848 2.45l-2.164 1.377c-5.671 3.346-13.165 2.738-19.425 1.486C305 449 305 449 303.75 446.75L303 444l-1.016-2.75c-1.043-3.446-1.328-6.4-1.476-9.992l-.19-3.944-.093-2.07C297.686 371.182 276.958 327.024 245 284l-1.205-1.625C228.382 261.689 210.752 241.645 191 225l-2.816-2.445C168.935 205.905 150.636 194.029 126 187l-2.048-.59c-21.586-5.908-47.622-4.735-67.405 6.04C44.283 199.916 39.107 211.605 35 225l-.75 2.293C27.45 251.708 39.663 281.813 47 305l.81 2.565c13.217 41.127 35.904 78.3 59.642 114.1a1101 1101 0 0 1 3.775 5.733C125.582 449.206 140.989 470.383 157 491l1.493 1.923a944 944 0 0 0 16.339 20.444 956 956 0 0 1 4.305 5.266c5.651 6.96 11.462 13.773 17.315 20.564q2.288 2.668 4.56 5.35a600 600 0 0 0 18.32 20.57A270 270 0 0 1 225.5 572c4.476 5.164 9.137 10.158 13.79 15.161q1.74 1.872 3.478 3.748c7.524 8.121 15.137 16.12 23.046 23.868 2.877 2.835 5.634 5.704 8.252 8.782 5.03 5.824 10.538 11.193 15.986 16.623q2.82 2.816 5.634 5.64c5.301 5.305 10.593 10.529 16.308 15.39 5.245 4.674 10.083 9.818 15.015 14.818 5.262 5.326 10.532 10.561 16.23 15.428 3.308 2.897 6.318 6.093 9.359 9.267 4.938 5.05 9.734 9.213 17.09 9.337L373 710c2.652-4.772 3.936-9.239 5.059-14.516l1.148-5.16.604-2.746c9.064-40.924 21.853-80.552 35.094-120.289q2.068-6.218 4.126-12.44a6145 6145 0 0 1 20.204-59.982 a14884 14884 0 0 0 16.89-49.68l.731-2.16c5.253-15.517 10.503-31.035 15.665-46.582Q475.752 386.72 479 377l1.006-3.013c14.378-43.03 29.699-85.455 46.94-127.417 3.53-8.602 7.04-17.212 10.554-25.82l1.273-3.117a14407 14407 0 0 0 29.601-73.104l5.667-14.082q5.499-13.656 10.983-27.318 2.728-6.799 5.464-13.594 2.586-6.42 5.159-12.848.955-2.38 1.915-4.76 1.326-3.288 2.638-6.58l.776-1.908c3.6-9.073 6.175-19.32 3.266-28.947-1.738-3.71-3.567-6.477-7.242-8.492-60.581-20.194-138.613 49.593-174.563 89.871Z"
                  />
                  <path
                    fill="currentColor"
                    d="M323 337h1v29h-1zM75 161h19v1H75zM576 26h18v1h-18zM341 844h1v16h-1zM34 235h1v15h-1zM603 37h1v12h-1zM297 407h1v11h-1zm1 20h1v10h-1zm13 26h9v1h-9zM100 185h9v1h-9zm-17 0h9v1h-9zm255 538 4 3-1 2c-1.5-1.375-1.5-1.375-3-3zM96 162h8v1h-8zm238 275h1v7h-1zm-1-8h1v7h-1zm-1-9h1v7h-1zm-1-9h1v7h-1zM66 162h7v1h-7zm329 712h1v6h-1zm-53-37h1v6h-1zm17-80h1v6h-1zm7-49h6v1h-6zM214 600l3 2-1 2zm116-196h1 v6h-1zm-34-5h1v6h-1zm33-2h1v6h-1zm-5-30h1v6h-1zm0-37h1v6h-1zM568 27h6v1h-6zM399 853h1v5h-1zm-40-104h1v5h-1zm-64-357h1v5h-1zm33-1h1v5h-1zm-3-17h1v5h-1zm0-50h1v5h-1zM0 265h1v5H0zm35-14h1v5h-1zm0-22h1v5h-1zm186-9 3 1-1 2zM0 216h1v5H0zm111-30h5v1h-5zm-6-23h5v1h-5zm-45 0h5v1h-5zm589-87h1v5h-1zm-88-48h5v1h-5zM259 646l3 1h-3zm-8-49 2 1-1 2zm-53-14 2 1-1 2zm38-2 2 1-1 2zm-23-333 2 1-1 2zm-14-13 3 1h-3zm-88-71 4 1Zm-55 0 4 1Z"
                  />
                </svg>
                by{" "}
                <span className="font-medium text-zinc-300 group-hover:text-lime-400 transition-colors">
                  rittik
                </span>
              </a>

              <span
                aria-hidden="true"
                className="mx-2 text-zinc-600 select-none"
              >
                •
              </span>

              <a
                href="https://github.com/rittikbasu/askmandi"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-lime-400 transition-colors"
                aria-label="View source code"
              >
                source code
              </a>
            </div>
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

            {tokenCount !== null && (
              <div className="rounded-full border border-zinc-700/50 bg-zinc-900/80 px-3 py-1.5 text-xs text-zinc-400">
                {new Intl.NumberFormat().format(tokenCount)} tokens
              </div>
            )}

            {ttft !== null && (
              <div className="rounded-full border border-zinc-700/50 bg-zinc-900/80 px-3 py-1.5 text-xs text-zinc-400">
                {ttft >= 1000
                  ? `${(ttft / 1000).toFixed(1)}s`
                  : `${ttft}ms`}{" "}
                TTFT
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
