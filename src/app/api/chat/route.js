import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { generateText, streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { encode as toToon } from "@toon-format/toon";
import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";

// Commodity names in db grouped by category - LLM uses this to map colloquial/Hindi names
const COMMODITIES = `[Vegetables] Amaranthus,Ashgourd,Beans,Beetroot,Bhindi/Ladies Finger,Bitter Gourd,Bottle Gourd,Brinjal,Cabbage,Capsicum,Carrot,Cauliflower,Cluster Beans,Coriander(Leaves),Cucumber/Kheera,Drumstick,Garlic,Ginger(Green),Green Chilli,Green Peas,Lemon,Methi(Leaves),Mint/Pudina,Mushrooms,Onion,Pointed Gourd/Parval,Potato,Pumpkin,Raddish,Ridgeguard/Tori,Spinach,Sweet Potato,Tinda,Tomato,Turnip,Yam
[Fruits] Amla,Apple,Banana,Ber,Chikoo/Sapota,Custard Apple,Grapes,Guava,Jack Fruit,Musk Melon,Kinnow,Mango,Mousambi/Sweet Lime,Orange,Papaya,Pear,Pineapple,Pomegranate,Water Melon
[Grains] Arhar/Tur Dal,Bajra,Barley/Jau,Bengal Gram/Chana,Black Gram/Urad,Green Gram/Moong,Jowar,Kabuli Chana,Lentil/Masur,Maize,Paddy,Ragi,Rice,Wheat
[Spices] Ajwan,Black Pepper,Chilli Red,Coriander Seed,Cumin/Jeera,Ginger(Dry),Methi Seeds,Mustard,Turmeric
[Oilseeds] Castor Seed,Coconut,Groundnut,Sesamum/Til,Soyabean,Sunflower
[Others] Arecanut/Supari,Cotton,Jaggery/Gur,Sugarcane,Tapioca`;

const log = (...args) => console.log("[api/chat]", ...args);
const encoder = new TextEncoder();

const MAX_INPUT_LENGTH = 200;
const DATA_START_DATE = "2026-01-05";

const UPSTASH_URL = process.env.KV_REST_API_URL;
const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN;

const redis =
  UPSTASH_URL && UPSTASH_TOKEN
    ? new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN })
    : null;

const ratelimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(10, "24h"),
      prefix: "askmandi:rl",
    })
  : null;

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

// Pricing per 1M tokens (in USD)
const PRICING = {
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
};

function calculateCost(fourNanoTokens = {}, fourMiniTokens = {}) {
  const fourNanoCost =
    ((fourNanoTokens.input || 0) * PRICING["gpt-4.1-nano"].input +
      (fourNanoTokens.output || 0) * PRICING["gpt-4.1-nano"].output) /
    1_000_000;
  const fourMiniCost =
    ((fourMiniTokens.input || 0) * PRICING["gpt-4.1-mini"].input +
      (fourMiniTokens.output || 0) * PRICING["gpt-4.1-mini"].output) /
    1_000_000;
  return {
    fourNanoCost,
    fourMiniCost,
    totalCost: fourNanoCost + fourMiniCost,
  };
}

function getTodayIST() {
  return new Date()
    .toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })
    .slice(0, 10);
}

const buildSqlPrompt = () => {
  const today = getTodayIST();

  return `Convert mandi price questions to SQL.

Table: mandi_prices (state, district, market, commodity, variety, grade, min_price, max_price, modal_price, arrival_date)
Prices: ₹/quintal. Use modal_price::numeric for comparisons.
Data available: ${DATA_START_DATE} to ${today} (~10,000 rows/day across all states)

Commodities (use exact Title Case, map Hindi terms like aloo→Potato, tamatar→Tomato, pyaaz→Onion):
${COMMODITIES}

Rules:
1. Default to latest date: WHERE arrival_date = (SELECT MAX(arrival_date) FROM mandi_prices)
2. Commodity: exact match commodity='Potato' or IN('Potato','Tomato'). ILIKE only for partial.
3. Category queries (vegetables/fruits): use IN() with category items, LIMIT 100
4. SELECT: Always include state, district, market for context. Add other columns as needed. Never SELECT *
5. Location: state ILIKE '%X%', district/market ILIKE '%Y%'
6. Cross-location comparisons: use GROUP BY with aggregates for fair comparison
7. Top/cheapest: ORDER BY modal_price::numeric, LIMIT 50
8. Trends: include arrival_date, order by date. For multi-location trends, ensure balanced data (no LIMIT or use per-location subqueries)

Reply UNCLEAR if gibberish/unrelated/too vague. Otherwise output only raw SQL.`;
};

const SUMMARY_PROMPT = `You summarize mandi price data concisely. Prices are ₹/quintal; show as ₹/kg (divide by 100). Use markdown. Be direct.

Critical rules:
- Data provided below EXISTS. Never say "no data" or "not available" when data is provided.
- Markets are within districts: if user asks about "Rajkot" and data shows district="Rajkot" with market="Gondal", that IS Rajkot data (Gondal is a market in Rajkot district).
- Focus on answering the user's question with the provided data.
- Be factual and concise.`;

const UNCLEAR_PROMPT = `You are Ask Mandi, a mandi-price assistant. The user's request can't be answered.

Write a short, friendly response that:
- Clearly states you couldn't understand or the data isn't available.
- Provides 2-3 specific example questions about mandi prices.

Keep it under 3 short paragraphs.`;

function sanitize(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-z0-9\s().,-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function isSafeSelect(sql) {
  const s = String(sql || "")
    .trim()
    .toLowerCase();
  if (!s || !s.startsWith("select")) return false;
  if (/[;](?!\s*$)/.test(s)) return false;
  if (
    /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/.test(s)
  )
    return false;
  return true;
}

function extractSql(text) {
  if (!text) return null;
  let sql = text.trim();
  const match = sql.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (match) sql = match[1].trim();
  return sql || null;
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

function parseDbResult(result) {
  try {
    const rawText = result?.content?.[0]?.text || "";
    const text = rawText.startsWith('"') ? JSON.parse(rawText) : rawText;
    const match = text.match(/\[[\s\S]*?\]/);
    return match ? JSON.parse(match[0]) : [];
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

// ─────────────────────────────────────────────────────────────────────────────
// Location extraction for fallback (single LLM call, only when needed)
// ─────────────────────────────────────────────────────────────────────────────

const LOCATION_EXTRACTOR_PROMPT = `Extract Indian locations from the query. Return ONLY valid JSON (no markdown):
{"locations": [{"name": "Place Name", "type": "state|district|city", "parentDistrict": "District or null", "parentState": "State or null"}]}

Rules:
- type: "state" for states, "district" for districts, "city" for cities/towns/villages/markets
- parentDistrict: for cities, the district they belong to (null for states/districts)
- parentState: the Indian state (null if type is "state")
- Common mappings:
  - Kalyan/Dombivli → Thane district, Maharashtra
  - Andheri/Bandra/Kurla → Mumbai district, Maharashtra
  - Gondal → Rajkot district, Gujarat
  - Ooty → Nilgiris district, Tamil Nadu
- Return empty array [] if no specific Indian location mentioned

Examples:
- "potato in Kalyan" → {"locations": [{"name": "Kalyan", "type": "city", "parentDistrict": "Thane", "parentState": "Maharashtra"}]}
- "prices in Tamil Nadu and Kerala" → {"locations": [{"name": "Tamil Nadu", "type": "state", "parentDistrict": null, "parentState": null}, {"name": "Kerala", "type": "state", "parentDistrict": null, "parentState": null}]}
- "tomato in Rajkot" → {"locations": [{"name": "Rajkot", "type": "district", "parentDistrict": null, "parentState": "Gujarat"}]}`;

async function extractLocations(userMessage) {
  const result = await generateText({
    model: openai("gpt-4.1-mini"),
    system: LOCATION_EXTRACTOR_PROMPT,
    prompt: userMessage,
    maxTokens: 150,
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
      {
        error: "Server misconfigured",
        details: "Set UPSTASH_REST_URL and UPSTASH_REST_TOKEN.",
      },
      { status: 500 }
    );
  }

  // Check cache FIRST (cached responses are free - no rate limit consumed)
  const normalizedMessage = normalizeCacheKey(lastUserMessage);
  const cacheKey = `askmandi:cache:v1:${normalizedMessage}`;

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

  // Rate limit only for non-cached (LLM) requests
  const visitorKey = getVisitorKey(req);
  const rl = await ratelimit.limit(visitorKey);

  if (!rl.success) {
    const retryAfterSeconds = rl.reset
      ? Math.max(1, Math.ceil((Number(rl.reset) - Date.now()) / 1000))
      : 3600;
    return Response.json(
      {
        error:
          "You've reached the daily limit of 10 questions. Please try again tomorrow :)",
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
        url: `https://mcp.supabase.com/mcp?project_ref=${projectRef}`,
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
    let fourNanoTokens = { input: 0, output: 0 };
    let fourMiniTokens = { input: 0, output: 0 };

    // Phase 1: Generate SQL directly (SQL model is smart enough to handle locations)

    const sqlPrompt = buildSqlPrompt();
    const sqlResult = await generateText({
      model: openai("gpt-4.1-mini"),
      system: sqlPrompt,
      prompt: lastUserMessage,
      maxTokens: 250,
      reasoningEffort: "low",
    });
    const sqlUsage = normalizeUsage(sqlResult.usage);
    totalUsage = addUsage(totalUsage, sqlUsage);
    fourMiniTokens.input += sqlUsage.inputTokens || 0;
    fourMiniTokens.output += sqlUsage.outputTokens || 0;

    const rawSql = (sqlResult.text || "").trim();
    log("SQL model response:", rawSql);

    // Handle unclear queries
    if (rawSql.toUpperCase() === "UNCLEAR" || !rawSql) {
      const clarification = await generateText({
        model: openai("gpt-4.1-nano"),
        system: UNCLEAR_PROMPT,
        prompt: `User message: ${lastUserMessage}`,
        maxTokens: 200,
      });
      const clarUsage = normalizeUsage(clarification.usage);
      totalUsage = addUsage(totalUsage, clarUsage);
      fourNanoTokens.input += clarUsage.inputTokens || 0;
      fourNanoTokens.output += clarUsage.outputTokens || 0;

      log("Tokens (unclear):", {
        "4nano": {
          input: fourNanoTokens.input,
          output: fourNanoTokens.output,
          total: fourNanoTokens.input + fourNanoTokens.output,
        },
        "4mini": {
          input: fourMiniTokens.input,
          output: fourMiniTokens.output,
          total: fourMiniTokens.input + fourMiniTokens.output,
        },
      });
      const cost = calculateCost(fourNanoTokens, fourMiniTokens);
      log("Cost (unclear):", { total: `$${cost.totalCost.toFixed(6)}` });

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
        fourNanoTokens.input += locationResult.usage.inputTokens || 0;
        fourNanoTokens.output += locationResult.usage.outputTokens || 0;
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
LIMIT 50;`;
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
LIMIT 50;`;
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

    const toonData = toToon(data);
    log(
      "TOON:",
      toonData.length,
      "chars vs JSON:",
      JSON.stringify(data).length,
      "chars"
    );

    const summaryResult = streamText({
      model: openai("gpt-4.1-nano"),
      system: SUMMARY_PROMPT,
      prompt: `Question: ${lastUserMessage}

${fallbackMessage ? `Note: ${fallbackMessage}` : ""}

Data:
${toonData}

Provide a helpful, concise answer.`,
      maxTokens: 300,
      temperature: 0, // Deterministic output
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
          fourNanoTokens.input += summaryUsage.inputTokens || 0;
          fourNanoTokens.output += summaryUsage.outputTokens || 0;
          const finalUsage = addUsage(totalUsage, summaryUsage);

          // Log token usage and cost breakdown
          log("Tokens:", {
            "4nano": {
              input: fourNanoTokens.input,
              output: fourNanoTokens.output,
              total: fourNanoTokens.input + fourNanoTokens.output,
            },
            "4mini": {
              input: fourMiniTokens.input,
              output: fourMiniTokens.output,
              total: fourMiniTokens.input + fourMiniTokens.output,
            },
          });
          const cost = calculateCost(fourNanoTokens, fourMiniTokens);
          log("Cost:", {
            "4nano": `$${cost.fourNanoCost.toFixed(6)}`,
            "4mini": `$${cost.fourMiniCost.toFixed(6)}`,
            total: `$${cost.totalCost.toFixed(6)}`,
          });

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
          controller.enqueue(
            encoder.encode(
              `event: error\ndata:${JSON.stringify({
                message: err?.message || "Stream error",
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
    return Response.json(
      { error: "Failed to process your question", details: error.message },
      { status: 500 }
    );
  }
}
