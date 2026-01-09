import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { generateText, streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { encode as toToon } from "@toon-format/toon";
import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";

// All commodity names in the db, helps LLM map colloquial names to official ones
const COMMODITIES = `Vegetables: Amaranthus, Ashgourd, Beans, Beetroot, Bhindi(Ladies Finger), Bitter Gourd, Bottle Gourd, Brinjal, Bunch Beans, Cabbage, Capsicum, Carrot, Cauliflower, Chow Chow, Cluster Beans, Colacasia, Coriander(Leaves), Cowpea(Veg), Cucumbar(Kheera), Drumstick, Elephant Yam(Suran), French Beans(Frasbean), Garlic, Ginger(Green), Green Chilli, Green Peas, Knool Khol, Ladies Finger, Leafy Vegetable, Lemon, Lime, Little Gourd(Kundru), Long Melon(Kakri), Methi(Leaves), Mint(Pudina), Mushrooms, Onion, Onion Green, Peas Cod, Peas Wet, Pointed Gourd(Parval), Potato, Pumpkin, Raddish, Ridgeguard(Tori), Round Gourd, Season Leaves, Snake Gourd, Spinach, Sponge Gourd, Squash, Sweet Potato, Taro Leaves, Tinda, Tomato, Turnip, Yam(Ratalu)
Fruits: Amla, Apple, Banana, Banana - Green, Ber, Chikoos(Sapota), Custard Apple, Grapes, Guava, Jack Fruit, Karbuja(Musk Melon), Kinnow, Kiwi, Mango, Mango(Raw-Ripe), Mousambi(Sweet Lime), Orange, Papaya, Papaya(Raw), Pear, Pineapple, Plum, Pomegranate, Tamarind Fruit, Water Melon
Grains & Pulses: Arhar Dal, Arhar(Tur/Red Gram), Bajra(Pearl Millet), Barley(Jau), Bengal Gram Dal, Bengal Gram(Whole), Black Gram Dal, Black Gram(Urd), Foxtail Millet, Green Gram Dal, Green Gram(Moong), Jowar(Sorghum), Kabuli Chana, Kulthi(Horse Gram), Lentil(Masur), Maize, Paddy(Basmati), Paddy(Common), Ragi(Finger Millet), Red Gram, Rice, Wheat, White Peas
Spices: Ajwan, Black Pepper, Chili Red, Dry Chillies, Coriander Seed, Cummin Seed(Jeera), Ginger(Dry), Methi Seeds, Mustard, Pepper Garbled, Poppy Seeds, Turmeric
Oilseeds: Castor Seed, Coconut, Copra, Groundnut, Linseed, Safflower, Sesamum(Til), Soyabean, Sunflower
Cash Crops: Arecanut(Supari), Betel Leaves, Coffee, Cotton, Gur(Jaggery), Jaggery, Jute, Rubber, Sugarcane, Tapioca`;

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

const LOCATION_RESOLVER_PROMPT = `You map a user's mentioned place to state and district from provided lists.

Return ONLY valid JSON (no markdown):
{"state": string|null, "district": string|null, "confidence": number, "reason": string}

Rules:
- state/district must be EXACTLY from the provided lists, or null if you can't decide.
- confidence is 0 to 1. Be conservative: if ambiguous, return null with low confidence.
- If the place IS a district in the list, set district to that exact value.
- If the place is a city/town/village, find its parent district.
- Common mappings: Kurla/Andheri/Bandra → Mumbai; Kalyan/Thane → Thane; Pune city → Pune.`;

const buildSqlPrompt = (locationContext) => {
  let locationHint = "";
  if (locationContext) {
    const { requestedPlace, state, district, searchTerms } = locationContext;
    locationHint = `\nLocation context for this query:
- User asked about: "${requestedPlace}"
- Resolved state: ${state || "unknown"}
- Resolved district: ${district || "none (user mentioned state only)"}`;

    if (district) {
      // User mentioned a specific place/district - search both place and district
      locationHint += `\n- Search terms for district/market: ${JSON.stringify(
        searchTerms
      )}
- Filter: state ILIKE '%${state}%' AND (district ILIKE '%${
        searchTerms[0]
      }%' OR market ILIKE '%${searchTerms[0]}%'${
        searchTerms[1]
          ? ` OR district ILIKE '%${searchTerms[1]}%' OR market ILIKE '%${searchTerms[1]}%'`
          : ""
      })`;
    } else if (state) {
      // User only mentioned a state - just filter by state, no district/market filter needed
      locationHint += `\n- Filter by state only: state ILIKE '%${state}%'
- Do NOT add district/market filters - the user wants all data from this state.`;
    }
  }

  return `You convert user questions about Indian mandi (agricultural market) prices into SQL queries.

Table: mandi_prices
Columns: state, district, market, commodity, variety, grade, min_price, max_price, modal_price, arrival_date
Prices are in ₹/quintal (100 kg).

Commodity names in database:
${COMMODITIES}
${locationHint}

Rules:
- Always filter by latest date: WHERE arrival_date = (SELECT MAX(arrival_date) FROM mandi_prices)
- Commodity matching - use EXACT Title Case names from the COMMODITIES list above:
  - Map user's term to the exact name: "aloo" → 'Potato', "tamatar" → 'Tomato', "pyaaz" → 'Onion'
  - Single commodity: commodity = 'Potato' (exact match, case-sensitive)
  - Multiple commodities: commodity IN ('Potato', 'Tomato', 'Onion')
  - For partial/fuzzy matches only: commodity ILIKE '%partial%'
- For category queries like "vegetables" or "fruits":
  - Use IN(...) with the exact Title Case names from COMMODITIES
  - Example: commodity IN ('Potato', 'Tomato', 'Onion', 'Brinjal', 'Cabbage', ...)
  - For broad categories, include common items and add LIMIT 100
- Use modal_price for price comparisons (cast to numeric for math/order): modal_price::numeric
- SELECT ONLY columns needed to answer the question (minimize tokens):
  - Price queries: state, district, market, commodity, modal_price (skip variety/grade unless asked)
  - Availability queries: DISTINCT state, commodity (or district, commodity)
  - Comparison queries: state, commodity, modal_price (aggregated)
  - Only include variety/grade/min_price/max_price if specifically relevant
- For location filtering, use the provided search terms if available:
  - Example: (district ILIKE '%term1%' OR market ILIKE '%term1%' OR district ILIKE '%term2%' OR market ILIKE '%term2%')
  - Also filter by state if provided: AND state ILIKE '%Maharashtra%'
  - If user mentions a state (like Gujarat), filter by state but DON'T also require district/market to match the state name.
- For comparisons across states/districts, use aggregates (GROUP BY) instead of raw rows.
- For "top/cheapest/highest" queries: SELECT DISTINCT, ORDER BY modal_price::numeric, LIMIT 10-200.
- NEVER use SELECT *
- If the user asks for "all data" or unbounded dumps, respond UNCLEAR

If the question is gibberish, unrelated, or too vague, respond with ONLY: UNCLEAR

Otherwise, output ONLY the raw SQL query. No markdown, no code blocks, no explanation.`;
};

const SUMMARY_PROMPT = `You summarize mandi price data concisely. Prices are ₹/quintal; show as ₹/kg (divide by 100). Use markdown. Be direct.

Critical rules:
- If data is provided below, it EXISTS in our database. Never say "no data" or "not available" when data is provided.
- If "Preface already sent" is provided, do NOT repeat it. Continue naturally after it.
- Focus on answering the user's question with the provided data.
- List specific items from the data (states, commodities, markets) to prove the data exists.
- Be factual: if data shows 5 states, say "data for 5 states" not "I don't have data".`;

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

function extractLocationHint(text) {
  const s = String(text || "").trim();
  if (!s) return null;

  // Skip location extraction for comparison/exclusion queries
  // These need the full query context, not just location filtering
  const comparisonPatterns = [
    /\b(?:but\s+not|not\s+in|except|excluding|only\s+in|unique\s+to)\b/i,
    /\bavailable\s+.*\bbut\b/i,
    /\bcompare\b.*\b(?:with|to|and)\b/i,
    /\bwhat\s+(?:states?|districts?|data)\s+do\s+you\s+have\b/i,
  ];
  if (comparisonPatterns.some((p) => p.test(s))) return null;

  const m = s.match(/\b(?:in|near|around|at)\s+([a-z][a-z\s().,-]{2,60})/i);
  if (!m) return null;
  const raw = m[1].split(/[?.!,;:\n]/)[0].trim();
  const cleaned = sanitize(raw);
  if (!cleaned || cleaned.length < 3) return null;
  if (["india", "today", "yesterday", "now"].includes(cleaned.toLowerCase()))
    return null;
  return cleaned;
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

// Check if any row contains the place (word-boundary match)
function rowContainsPlace(row, place) {
  if (!row || !place) return false;
  const tokens = sanitize(place)
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  if (!tokens.length) return false;

  const fields = [row.district, row.market, row.state]
    .filter(Boolean)
    .map((v) => String(v).toLowerCase());

  const match = (text, token) => {
    const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(text);
  };

  return fields.some((f) => tokens.every((t) => match(f, t)));
}

// DB cache (states/districts)

let statesCache = null;
let statesCacheAt = 0;
const districtsCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 min

async function getStates(runQuery) {
  if (statesCache && Date.now() - statesCacheAt < CACHE_TTL) return statesCache;
  const rows = await runQuery(
    "SELECT DISTINCT state FROM mandi_prices ORDER BY state;"
  );
  statesCache = rows.map((r) => r.state).filter(Boolean);
  statesCacheAt = Date.now();
  return statesCache;
}

async function getDistricts(runQuery, state) {
  const key = String(state).toLowerCase();
  const cached = districtsCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.districts;

  const s = sanitize(state).replace(/'/g, "''");
  const rows = await runQuery(
    `SELECT DISTINCT district FROM mandi_prices WHERE state ILIKE '%${s}%' ORDER BY district;`
  );
  const districts = rows.map((r) => r.district).filter(Boolean);
  districtsCache.set(key, { districts, at: Date.now() });
  return districts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Location resolution (BEFORE SQL generation)
// ─────────────────────────────────────────────────────────────────────────────

async function resolveLocation(runQuery, requestedPlace, userMessage) {
  // Step 1: Get all states from DB
  const states = await getStates(runQuery);

  // Step 2: Check if user explicitly mentioned a state
  const msgLower = userMessage.toLowerCase();
  let state = states.find((s) => msgLower.includes(s.toLowerCase())) || null;

  // Step 3: If no explicit state, use LLM to infer from place name
  let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let district = null;

  if (!state) {
    // Single LLM call: resolve both state and district together
    // First get a reasonable subset of districts (top states by data volume or all)
    // For simplicity, we'll do a two-step: state first, then district
    const stateResult = await generateText({
      model: openai("gpt-4.1-nano"),
      system: `You identify which Indian state a place belongs to.
Return ONLY valid JSON: {"state": string|null, "confidence": number}
The state must be EXACTLY one of these: ${JSON.stringify(states)}
Common: Kurla/Mumbai/Thane → Maharashtra; Kolkata → West Bengal; Chennai → Tamil Nadu; Bangalore → Karnataka.`,
      prompt: `Place: ${requestedPlace}`,
      maxTokens: 80,
    });
    usage = addUsage(usage, normalizeUsage(stateResult.usage));

    const parsed = extractJson(stateResult.text);
    if (parsed?.state && Number(parsed.confidence) >= 0.5) {
      state = parsed.state;
    }
  }

  // Step 4: If we have a state, resolve district
  if (state) {
    const districts = await getDistricts(runQuery, state);

    // Check if requestedPlace IS a district (exact match)
    district =
      districts.find((d) => d.toLowerCase() === requestedPlace.toLowerCase()) ||
      null;

    // If not exact, use LLM to find parent district
    if (!district && districts.length > 0) {
      const distResult = await generateText({
        model: openai("gpt-4.1-nano"),
        system: LOCATION_RESOLVER_PROMPT,
        prompt: `State: ${state}
Place: ${requestedPlace}
Districts in ${state}: ${JSON.stringify(districts)}`,
        maxTokens: 100,
      });
      usage = addUsage(usage, normalizeUsage(distResult.usage));

      const parsed = extractJson(distResult.text);
      if (parsed?.district && Number(parsed.confidence) >= 0.5) {
        district = parsed.district;
      }
    }
  }

  // Build search terms: always include user's place + resolved district if different
  const searchTerms = [requestedPlace];
  if (district && district.toLowerCase() !== requestedPlace.toLowerCase()) {
    searchTerms.push(district);
  }

  return {
    requestedPlace,
    state,
    district,
    searchTerms,
    isExact: district?.toLowerCase() === requestedPlace.toLowerCase(),
    usage,
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
          "You've reached the limit of 10 questions per 24 hours. Please try again tomorrow :)",
        remaining: 0,
        reset: rl.reset,
      },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
    );
  }

  // Pass remaining quota in all responses so frontend can track
  const remaining = rl.remaining;

  const requestedPlace = extractLocationHint(lastUserMessage);
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

    // Phase 1: Resolve location BEFORE generating SQL

    let locationContext = null;
    if (requestedPlace) {
      locationContext = await resolveLocation(
        runQuery,
        requestedPlace,
        lastUserMessage
      );
      totalUsage = addUsage(totalUsage, locationContext.usage);
      fourNanoTokens.input += locationContext.usage.inputTokens || 0;
      fourNanoTokens.output += locationContext.usage.outputTokens || 0;
      log("Location resolved", {
        place: requestedPlace,
        state: locationContext.state,
        district: locationContext.district,
        terms: locationContext.searchTerms,
      });
    }

    // Phase 2: Generate SQL with location context

    const sqlPrompt = buildSqlPrompt(locationContext);
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
      throw new Error("Failed to generate safe SQL query");
    }

    // Phase 3: Execute SQL (single query, no reruns!)

    let data = await runQuery(sql);
    log("SQL returned", data.length, "rows");

    // Check if we got an exact match for the requested place
    let exactMatch = false;
    if (requestedPlace && data.length > 0) {
      exactMatch = data.some((row) => rowContainsPlace(row, requestedPlace));
    }

    // If no data and we have location context, try a broader fallback (state-level)
    if (data.length === 0 && locationContext?.state) {
      // Extract commodity from the generated SQL
      const commodityMatch = sql.match(/commodity\s+ilike\s+'%([^%']+)%'/i);
      const commodity = commodityMatch?.[1];

      if (commodity) {
        const st = sanitize(locationContext.state).replace(/'/g, "''");
        const fallbackSql = `SELECT DISTINCT state, district, market, variety, grade, min_price, max_price, modal_price
FROM mandi_prices
WHERE arrival_date = (SELECT MAX(arrival_date) FROM mandi_prices)
  AND commodity ILIKE '%${commodity}%'
  AND state ILIKE '%${st}%'
ORDER BY modal_price::numeric
LIMIT 50;`;
        data = await runQuery(fallbackSql);
        log("Fallback to state-level returned", data.length, "rows");
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
        message: requestedPlace
          ? `No results found for **${requestedPlace}** on the latest date. Try a nearby district or the whole state.`
          : "No results found. Try checking the commodity name or broadening your search.",
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

    // Build honest prefix when we couldn't match exact place
    // Skip if requestedPlace is essentially the same as resolved location (case-insensitive)
    let forcedPrefix = "";
    if (requestedPlace && !exactMatch) {
      const showing =
        locationContext?.district || locationContext?.state || "available data";
      const isSameLocation =
        showing.toLowerCase() === requestedPlace.toLowerCase();
      if (!isSameLocation) {
        forcedPrefix = `No data for **${requestedPlace}** on the latest date. Showing **${showing}** instead.\n\n`;
      }
    }

    const summaryResult = streamText({
      model: openai("gpt-4.1-nano"),
      system: SUMMARY_PROMPT,
      prompt: `Question: ${lastUserMessage}

${forcedPrefix ? `Preface already sent: "${forcedPrefix.trim()}"` : ""}

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

          // Send forced prefix first
          if (forcedPrefix) {
            fullText += forcedPrefix;
            controller.enqueue(
              encoder.encode(
                `event: delta\ndata:${JSON.stringify({
                  delta: forcedPrefix,
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
