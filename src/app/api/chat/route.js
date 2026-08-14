import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { generateText, streamText } from "ai";
import { createGroq } from "@ai-sdk/groq";
import { encode as toToon } from "@toon-format/toon";
import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import {
  buildSqlPrompt,
  buildSummaryPrompt,
  UNCLEAR_PROMPT,
  LOCATION_EXTRACTOR_PROMPT,
} from "@/lib/prompts";
import { getModelConfig } from "@/lib/model-config.mjs";
import { buildReadOnlyMcpUrl } from "@/lib/mcp-config.mjs";
import { prepareDisplayRows } from "@/lib/display-rows.mjs";
import { shouldBypassVisitorRateLimit } from "@/lib/runtime-config.mjs";
import { extractSql, isSafeSelect } from "@/lib/sql-output.mjs";
import {
  getDailyProviderLimitMessage,
  hasExhaustedDailyProviderCapacity,
} from "@/lib/provider-error.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const { baseURL, apiKey, model: MODEL } = getModelConfig();
const groq = createGroq({
  baseURL,
  apiKey,
});

const MAX_INPUT_LENGTH = 200;
const DATA_START_DATE = "2026-01-05";
const FALLBACK_MAX_ROWS = 5;

const log = (...args) => console.log("[api/chat]", ...args);
const encoder = new TextEncoder();

const UPSTASH_URL = process.env.KV_REST_API_URL;
const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN;

const redis =
  UPSTASH_URL && UPSTASH_TOKEN
    ? new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN })
    : null;

const ratelimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(10, "12h"),
      prefix: "askmandi:rl",
    })
  : null;

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return "a moment";
}

// Track usage by exact model. Groq account limits and billing are provider-managed.
function trackTokens(usage, modelName, tokenBuckets) {
  const bucket = tokenBuckets[modelName] || (tokenBuckets[modelName] = { input: 0, output: 0 });
  bucket.input += usage.inputTokens || 0;
  bucket.output += usage.outputTokens || 0;
}

function normalizeCacheKey(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/[?!.]+$/g, "");
}

function getNextRefreshTTLSeconds() {
  // TTL until next 3:30pm IST (data refresh time)
  const now = new Date();
  const istNow = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );
  const target = new Date(istNow);
  target.setHours(15, 30, 0, 0);
  if (istNow >= target) target.setDate(target.getDate() + 1);
  return Math.max(60, Math.floor((target.getTime() - istNow.getTime()) / 1000));
}

function getVisitorKey(req) {
  // Best-effort visitor key without auth.
  const h = req.headers;
  const xff = h.get("x-forwarded-for");
  const ip =
    (xff ? xff.split(",")[0].trim() : null) ||
    h.get("x-real-ip") ||
    h.get("cf-connecting-ip") ||
    null;
  const ua = h.get("user-agent") || "unknown";

  // Normalize UA by keeping only stable parts before variable identifiers
  // This ensures the same device gets the same rate limit bucket
  // Stop at KHTML/like Gecko/Build which often have variable parts
  const stopPatterns = /\s*\(KHT|\s*\(KHTML|\s+like\s+Gecko|\s+Build\//i;
  const match = ua.match(stopPatterns);
  const stableUA = match ? ua.substring(0, match.index) : ua;

  const normalizedUA = stableUA
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim()
    .slice(0, 70);

  return `ip:${ip || "unknown"}|ua:${normalizedUA}`;
}

// Get current date in IST (YYYY-MM-DD format for SQL)
function getTodayIST() {
  return new Date()
    .toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })
    .slice(0, 10);
}


function sanitize(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-z0-9\s().,-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function extractJson(text) {
  try {
    const raw = String(text || "").trim();
    const s = raw.startsWith('"') ? JSON.parse(raw) : raw;
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractRowsFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];

  const parsed = tryParseJson(raw);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && parsed.result) {
    return extractRowsFromText(parsed.result);
  }

  const tagged = raw.match(
    /<untrusted-data-[^>]+>\s*([\s\S]*?)\s*<\/untrusted-data-[^>]+>/i
  );
  const candidate = tagged?.[1] || raw;
  const arrayMatch = candidate.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return [];

  const directArray = tryParseJson(arrayMatch[0]);
  if (Array.isArray(directArray)) return directArray;

  const unescapedArray = tryParseJson(arrayMatch[0].replace(/\\"/g, '"'));
  return Array.isArray(unescapedArray) ? unescapedArray : [];
}

function parseDbResult(result) {
  try {
    if (Array.isArray(result?.toolResult)) return result.toolResult;

    for (const item of result?.content || []) {
      if (typeof item?.text === "string") {
        const rows = extractRowsFromText(item.text);
        if (rows.length) return rows;
      }

      if (typeof item?.resource?.text === "string") {
        const rows = extractRowsFromText(item.resource.text);
        if (rows.length) return rows;
      }
    }

    return [];
  } catch (e) {
    log("Data extraction error:", e.message);
    return [];
  }
}

function normalizeUsage(raw = {}) {
  const i = raw.inputTokens ?? raw.promptTokens ?? 0;
  const o = raw.outputTokens ?? raw.completionTokens ?? 0;
  return {
    inputTokens: i,
    outputTokens: o,
    totalTokens: raw.totalTokens ?? i + o,
  };
}

function addUsage(a, b) {
  return {
    inputTokens: (a.inputTokens || 0) + (b.inputTokens || 0),
    outputTokens: (a.outputTokens || 0) + (b.outputTokens || 0),
    totalTokens: (a.totalTokens || 0) + (b.totalTokens || 0),
  };
}

function logTokensAndCost(tokenBuckets, label = "") {
  const suffix = label ? ` (${label})` : "";
  const usage = Object.fromEntries(
    Object.entries(tokenBuckets).map(([model, tokens]) => [
      model,
      { ...tokens, total: tokens.input + tokens.output },
    ])
  );
  log(`Tokens${suffix}:`, usage);
}

// Location extraction for fallback (single LLM call, only when needed)
async function extractLocations(userMessage) {
  const result = await generateText({
    model: groq(MODEL),
    system: LOCATION_EXTRACTOR_PROMPT,
    prompt: userMessage,
    maxOutputTokens: 150,
    providerOptions: { groq: { reasoningFormat: "hidden", reasoningEffort: "low" } },
  });

  const parsed = extractJson(result.text);
  return {
    locations: parsed?.locations || [],
    usage: normalizeUsage(result.usage),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req) {
  const { messages } = await req.json();

  if (!messages?.length) {
    return Response.json(
      { error: "Messages array is required" },
      { status: 400 }
    );
  }

  const lastUserMessage =
    [...messages].reverse().find((m) => m?.role === "user")?.content || "";
  log("Incoming request", { lastUser: lastUserMessage });

  // Validate input length
  if (lastUserMessage.length > MAX_INPUT_LENGTH) {
    return Response.json(
      {
        error: `Message too long. Maximum ${MAX_INPUT_LENGTH} characters allowed.`,
      },
      { status: 400 }
    );
  }

  if (!redis || !ratelimit) {
    return Response.json(
      { error: "Service temporarily unavailable. Please try again later." },
      { status: 500 }
    );
  }

  // Check cache FIRST (cached responses are free - no rate limit consumed)
  const normalizedMessage = normalizeCacheKey(lastUserMessage);
  const cacheKey = `askmandi:cache:v19:${MODEL}:${normalizedMessage}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached && typeof cached === "object" && cached.message) {
      log("Cache hit (free)", { key: cacheKey });
      return Response.json({
        message: cached.message,
        usage: cached.usage || null,
        cached: true,
      });
    }
  } catch (e) {
    log("Cache read failed", { message: e?.message });
  }

  // The public visitor quota is intentionally disabled only for `next dev`.
  // Preview and production both run with NODE_ENV=production, so they cannot bypass it.
  const bypassVisitorRateLimit = shouldBypassVisitorRateLimit();
  const visitorKey = getVisitorKey(req);
  const rl = bypassVisitorRateLimit
    ? { success: true, remaining: null }
    : await ratelimit.limit(visitorKey);

  if (!rl.success) {
    const retryAfterSeconds = rl.reset
      ? Math.max(1, Math.ceil((Number(rl.reset) - Date.now()) / 1000))
      : 3600;
    const timer = formatDuration(retryAfterSeconds);
    return Response.json(
      {
        error: `You've reached the limit of 10 questions. Please try again in ${timer}.`,
        remaining: 0,
        reset: rl.reset,
      },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
    );
  }

  // Pass remaining quota in all responses so frontend can track
  const remaining = rl.remaining;

  let mcpClient = null;

  try {
    const projectRef = process.env.SUPABASE_PROJECT_REF;
    const pat = process.env.SUPABASE_PAT;
    if (!projectRef || !pat) {
      throw new Error(
        "SUPABASE_PROJECT_REF and SUPABASE_PAT must be configured"
      );
    }

    // Connect to MCP
    mcpClient = await createMCPClient({
      transport: {
        type: "http",
        url: buildReadOnlyMcpUrl(projectRef),
        headers: { Authorization: `Bearer ${pat}` },
      },
    });
    const mcpTools = await mcpClient.tools();
    if (!mcpTools.execute_sql)
      throw new Error("MCP did not expose execute_sql");

    const runQuery = async (query) => {
      if (!isSafeSelect(query)) throw new Error("Unsafe query blocked");
      const res = await mcpTools.execute_sql.execute({ query });
      return parseDbResult(res);
    };

    let totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const tokenBuckets = {};

    // Phase 1: Convert the question into a bounded, read-only query.
    const sqlPrompt = buildSqlPrompt(DATA_START_DATE, getTodayIST());
    const sqlResult = await generateText({
      model: groq(MODEL),
      system: sqlPrompt,
      prompt: lastUserMessage,
      maxOutputTokens: 300,
      providerOptions: {
        groq: { reasoningFormat: "hidden", reasoningEffort: "low" },
      },
    });
    const sqlUsage = normalizeUsage(sqlResult.usage);
    totalUsage = addUsage(totalUsage, sqlUsage);
    trackTokens(sqlUsage, MODEL, tokenBuckets);
    const rawSql = (sqlResult.text || "").trim();
    log("SQL model response:", rawSql);

    // Handle unclear queries
    if (rawSql.toUpperCase() === "UNCLEAR" || !rawSql) {
      const clarification = await generateText({
        model: groq(MODEL),
        system: UNCLEAR_PROMPT,
        prompt: `User message: ${lastUserMessage}`,
        maxOutputTokens: 120,
        providerOptions: { groq: { reasoningFormat: "hidden", reasoningEffort: "low" } },
      });
      const clarUsage = normalizeUsage(clarification.usage);
      totalUsage = addUsage(totalUsage, clarUsage);
      trackTokens(clarUsage, MODEL, tokenBuckets);

      logTokensAndCost(tokenBuckets, "unclear");

      if (mcpClient?.close) await mcpClient.close();
      return Response.json({
        message:
          clarification.text ||
          "I couldn't understand. Try asking about mandi prices.",
        usage: totalUsage,
        remaining,
      });
    }

    const sql = extractSql(rawSql);
    if (!sql || !isSafeSelect(sql)) {
      log("Unsafe SQL blocked:", rawSql);
      if (mcpClient?.close) await mcpClient.close();
      return Response.json({
        message:
          "I couldn't process that request safely. Please try asking about commodity prices, markets, or trends in a different way.",
        usage: totalUsage,
        remaining,
      });
    }

    // Phase 2: Execute SQL

    let data = await runQuery(sql);
    log("SQL returned", data.length, "rows");

    // Phase 3: Fallback if no data - try broader location (district → state)
    let fallbackMessage = null;
    if (data.length === 0) {
      // Extract commodity from the generated SQL
      const commodityMatch =
        sql.match(/commodity\s*=\s*'([^']+)'/i) ||
        sql.match(/commodity\s+ilike\s+'%([^%']+)%'/i);
      const commodity = commodityMatch?.[1];

      if (commodity) {
        // Use location extractor to understand what places the user asked about
        const locationResult = await extractLocations(lastUserMessage);
        totalUsage = addUsage(totalUsage, locationResult.usage);
        trackTokens(
          locationResult.usage,
          MODEL,
          tokenBuckets
        );
        log("Locations extracted for fallback:", locationResult.locations);

        // Find a city that has parentDistrict for fallback
        const city = locationResult.locations.find(
          (loc) => loc.type === "city" && loc.parentDistrict
        );

        // Step 1: If city with parentDistrict, try district first
        if (city?.parentDistrict) {
          const district = sanitize(city.parentDistrict).replace(/'/g, "''");
          const districtSql = `SELECT state, district, market, commodity, modal_price
FROM mandi_prices
WHERE arrival_date = (SELECT MAX(arrival_date) FROM mandi_prices)
  AND commodity = '${commodity}'
  AND district ILIKE '%${district}%'
ORDER BY modal_price::numeric
LIMIT ${FALLBACK_MAX_ROWS};`;
          data = await runQuery(districtSql);
          log("Fallback to district-level returned", data.length, "rows");

          if (data.length > 0) {
            fallbackMessage = `No exact data for **${city.name}**. Showing data from **${city.parentDistrict}** district instead.`;
          }
        }

        // Step 2: If still no data and we have parentState, try state
        if (data.length === 0) {
          const locWithState = locationResult.locations.find(
            (loc) => loc.type !== "state" && loc.parentState
          );

          if (locWithState?.parentState) {
            const state = sanitize(locWithState.parentState).replace(
              /'/g,
              "''"
            );
            const stateSql = `SELECT state, district, market, commodity, modal_price
FROM mandi_prices
WHERE arrival_date = (SELECT MAX(arrival_date) FROM mandi_prices)
  AND commodity = '${commodity}'
  AND state ILIKE '%${state}%'
ORDER BY modal_price::numeric
LIMIT ${FALLBACK_MAX_ROWS};`;
            data = await runQuery(stateSql);
            log("Fallback to state-level returned", data.length, "rows");

            if (data.length > 0) {
              fallbackMessage = `No exact data for **${locWithState.name}**. Showing data from **${locWithState.parentState}** instead.`;
            }
          }
        }
      }
    }

    // Close MCP early
    if (mcpClient?.close) {
      await mcpClient.close();
      mcpClient = null;
    }

    // No data at all
    if (data.length === 0) {
      return Response.json({
        message:
          "No results found. Try checking the commodity name or broadening your search.",
        usage: totalUsage,
        remaining,
      });
    }

    // Phase 4: Stream summary

    // Truncate to 100 rows max for summarizer (SQL is cheap, LLM tokens aren't)
    const MAX_ROWS = 100;
    const originalRowCount = data.length;
    const wasTruncated = originalRowCount > MAX_ROWS;
    if (wasTruncated) {
      data = data.slice(0, MAX_ROWS);
      log(`Truncated ${originalRowCount} rows to ${MAX_ROWS}`);
    }

    const displayRows = prepareDisplayRows(data);
    const toonData = toToon(displayRows);
    log(
      "TOON:",
      toonData.length,
      "chars vs JSON:",
      JSON.stringify(data).length,
      "chars"
    );

    const summaryPrompt = buildSummaryPrompt();

    const limitNote =
      !wasTruncated && data.length === MAX_ROWS
        ? `\nNote: Results were truncated for brevity. Showing ${MAX_ROWS} results. Ask a more specific question to see more.`
        : "";

    const summaryResult = streamText({
      model: groq(MODEL),
      system: summaryPrompt,
      prompt: `Question: ${lastUserMessage}
${fallbackMessage ? `\nNote: ${fallbackMessage}` : ""}${limitNote}

Data:
${toonData}`,
      maxOutputTokens: 1500,
      providerOptions: { groq: { reasoningFormat: "hidden", reasoningEffort: "low" } },
    });

    // Stream response
    const stream = new ReadableStream({
      async start(controller) {
        try {
          let fullText = "";

          // Send fallback message first if we had to broaden the search
          if (fallbackMessage) {
            const prefix = fallbackMessage + "\n\n";
            fullText += prefix;
            controller.enqueue(
              encoder.encode(
                `event: delta\ndata:${JSON.stringify({
                  delta: prefix,
                })}\n\n`
              )
            );
          }

          // Stream LLM response
          for await (const delta of summaryResult.textStream) {
            fullText += delta;
            controller.enqueue(
              encoder.encode(
                `event: delta\ndata:${JSON.stringify({ delta })}\n\n`
              )
            );
          }

          const summaryUsage = normalizeUsage(
            await summaryResult.usage.catch(() => ({}))
          );
          trackTokens(summaryUsage, MODEL, tokenBuckets);
          const finalUsage = addUsage(totalUsage, summaryUsage);

          logTokensAndCost(tokenBuckets);

          // Cache response until next 3:30pm IST (data refresh time)
          if (cacheKey && redis) {
            try {
              const ttl = getNextRefreshTTLSeconds();
              await redis.set(
                cacheKey,
                { message: fullText, usage: finalUsage },
                { ex: ttl }
              );
              log("Cache set", { key: cacheKey, ttlSeconds: ttl });
            } catch (e) {
              log("Cache write failed", { message: e?.message });
            }
          }

          controller.enqueue(
            encoder.encode(
              `event: done\ndata:${JSON.stringify({
                fullText,
                usage: finalUsage,
                remaining,
              })}\n\n`
            )
          );
          controller.close();
        } catch (err) {
          const dailyProviderLimit = hasExhaustedDailyProviderCapacity(err);
          controller.enqueue(
            encoder.encode(
              `event: error\ndata:${JSON.stringify({
                message: dailyProviderLimit
                  ? getDailyProviderLimitMessage()
                  : "Sorry, I couldn't finish that answer. Please try again.",
              })}\n\n`
            )
          );
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("[api/chat] Error", error);
    if (mcpClient?.close) {
      try {
        await mcpClient.close();
      } catch {}
    }
    if (hasExhaustedDailyProviderCapacity(error)) {
      return Response.json(
        { error: getDailyProviderLimitMessage() },
        { status: 503 }
      );
    }
    return Response.json(
      { error: "Failed to process your question" },
      { status: 500 }
    );
  }
}
