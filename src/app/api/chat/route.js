import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { generateText, streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { encode as toToon } from "@toon-format/toon";

// All commodity names in the database - helps LLM map colloquial names to official ones
const COMMODITIES = `Vegetables: amaranthus, ashgourd, beans, beetroot, bhindi(ladies finger), bitter gourd, bottle gourd, brinjal, bunch beans, cabbage, capsicum, carrot, cauliflower, chow chow, cluster beans, colacasia, coriander(leaves), cowpea(veg), cucumbar(kheera), drumstick, elephant yam(suran), french beans(frasbean), garlic, ginger(green), green chilli, green peas, knool khol, ladies finger, leafy vegetable, lemon, lime, little gourd(kundru), long melon(kakri), methi(leaves), mint(pudina), mushrooms, onion, onion green, peas cod, peas wet, pointed gourd(parval), potato, pumpkin, raddish, ridgeguard(tori), round gourd, season leaves, snake gourd, spinach, sponge gourd, squash, sweet potato, taro leaves, tinda, tomato, turnip, yam(ratalu)
Fruits: amla, apple, banana, banana - green, ber, chikoos(sapota), custard apple, grapes, guava, jack fruit, karbuja(musk melon), kinnow, kiwi, mango, mango(raw-ripe), mousambi(sweet lime), orange, papaya, papaya(raw), pear, pineapple, plum, pomegranate, tamarind fruit, water melon
Grains & Pulses: arhar dal, arhar(tur/red gram), bajra(pearl millet), barley(jau), bengal gram dal, bengal gram(whole), black gram dal, black gram(urd), foxtail millet, green gram dal, green gram(moong), jowar(sorghum), kabuli chana, kulthi(horse gram), lentil(masur), maize, paddy(basmati), paddy(common), ragi(finger millet), red gram, rice, wheat, white peas
Spices: ajwan, black pepper, chili red, dry chillies, coriander seed, cummin seed(jeera), ginger(dry), methi seeds, mustard, pepper garbled, poppy seeds, turmeric
Oilseeds: castor seed, coconut, copra, groundnut, linseed, safflower, sesamum(til), soyabean, sunflower
Cash Crops: arecanut(supari), betel leaves, coffee, cotton, gur(jaggery), jaggery, jute, rubber, sugarcane, tapioca`;

const SQL_PROMPT = `You convert user questions about Indian mandi (agricultural market) prices into SQL queries.

Table: mandi_prices
Columns: state, district, market, commodity, variety, grade, min_price, max_price, modal_price, arrival_date
Prices are in ₹/quintal (100 kg).

Commodity names in database:
${COMMODITIES}

Rules:
- Always filter by latest date: WHERE arrival_date = (SELECT MAX(arrival_date) FROM mandi_prices)
- Case-insensitive commodity search: commodity ILIKE '%tomato%'
- Use modal_price for price comparisons (cast to numeric for math/order): modal_price::numeric
- Avoid misleading sampling for comparisons:
  - If the user asks to compare across states/districts/markets, prefer an AGGREGATED result (e.g. one row per state) instead of returning raw rows.
  - Example (compare across states): SELECT state, COUNT(*) AS rows, COUNT(DISTINCT market) AS markets, MIN(modal_price::numeric) AS min_modal, MAX(modal_price::numeric) AS max_modal, AVG(modal_price::numeric) AS avg_modal FROM mandi_prices WHERE arrival_date = (SELECT MAX(arrival_date) FROM mandi_prices) AND commodity ILIKE '%potato%' AND state IN ('Tamil Nadu','Kerala') GROUP BY state ORDER BY state;
- For "top/cheapest/highest" style questions, return raw rows but keep it bounded:
  - Prefer SELECT DISTINCT (to avoid duplicates)
  - Use ORDER BY with modal_price::numeric
  - Use LIMIT between 10 and 200 depending on how many items the user asked for (never more than 200)
- NEVER use SELECT *
- If the user asks for "all data", "everything", or an unbounded dump, respond UNCLEAR

IMPORTANT: If the question is:
- Gibberish, nonsensical, or unrelated to mandi/commodity prices
- About something not in the database (weather, news, general knowledge, etc.)
- Too vague to form a meaningful query

Then respond with ONLY the word: UNCLEAR

Otherwise, output ONLY the raw SQL query. No markdown, no code blocks, no explanation.`;

const SUMMARY_PROMPT = `You summarize mandi price data concisely. Prices are ₹/quintal; show as ₹/kg (divide by 100). Use markdown. Be direct, no preamble.`;

const UNCLEAR_PROMPT = `You are Ask Mandi, a mandi-price assistant. The SQL planner signaled that the user's request can't be answered (gibberish, unrelated, or too vague).

Write a short, friendly response that:
- Clearly states you couldn't understand or the data isn't available for that request.
- Provides 2-3 specific example questions the user can ask about mandi prices.

Keep it under 3 short paragraphs. Avoid repeating the user's gibberish.`;

const log = (...args) => console.log("[api/chat]", ...args);

const encoder = new TextEncoder();

function normalizeUsage(raw = {}) {
  const inputTokens =
    raw.inputTokens ?? raw.promptTokens ?? raw.totalPromptTokens ?? 0;
  const outputTokens =
    raw.outputTokens ?? raw.completionTokens ?? raw.totalCompletionTokens ?? 0;
  const totalTokens =
    raw.totalTokens ?? raw.total_usage ?? inputTokens + outputTokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens || inputTokens + outputTokens,
  };
}

function addUsage(a, b) {
  return {
    inputTokens: (a.inputTokens || 0) + (b.inputTokens || 0),
    outputTokens: (a.outputTokens || 0) + (b.outputTokens || 0),
    totalTokens: (a.totalTokens || 0) + (b.totalTokens || 0),
  };
}

function extractSqlFromResponse(text) {
  if (!text) return null;

  // Strip markdown code blocks if present
  let sql = text.trim();

  // Remove ```sql ... ``` or ``` ... ```
  const codeBlockMatch = sql.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch) {
    sql = codeBlockMatch[1].trim();
  }

  return sql || null;
}

function sanitizeSql(sql) {
  if (!sql) return sql;

  const trimmed = sql.trim();
  const hasGroupBy = /\bGROUP\s+BY\b/i.test(trimmed);
  const hasAggregate =
    /\b(COUNT|AVG|MIN|MAX|SUM|PERCENTILE_CONT|PERCENTILE_DISC)\s*\(/i.test(
      trimmed
    );
  const limitMatch = trimmed.match(/\bLIMIT\s+(\d+)\b/i);

  // If the query returns raw rows without any aggregation, enforce a reasonable bound.
  if (!limitMatch && !hasGroupBy && !hasAggregate) {
    return trimmed.replace(/;?\s*$/, "\nLIMIT 200;");
  }

  // If present, clamp extreme limits.
  if (limitMatch) {
    const n = Number(limitMatch[1]);
    if (Number.isFinite(n) && n > 500) {
      return trimmed.replace(/\bLIMIT\s+\d+\b/i, "LIMIT 500");
    }
    if (Number.isFinite(n) && n <= 0) {
      return trimmed.replace(/\bLIMIT\s+\d+\b/i, "LIMIT 200");
    }
  }

  return trimmed;
}

function extractJsonFromMcpResult(result) {
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

export async function POST(req) {
  const { messages } = await req.json();

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return Response.json(
      { error: "Messages array is required" },
      { status: 400 }
    );
  }

  const lastUserMessage =
    [...messages].reverse().find((m) => m?.role === "user")?.content || "";
  log("Incoming request", { lastUser: lastUserMessage });

  let mcpClient = null;

  try {
    const projectRef = process.env.SUPABASE_PROJECT_REF;
    if (!projectRef) {
      throw new Error("SUPABASE_PROJECT_REF is not configured");
    }
    const pat = process.env.SUPABASE_PAT;
    if (!pat) {
      throw new Error("SUPABASE_PAT is not configured");
    }

    // Phase 1: Generate SQL query
    const sqlResult = await generateText({
      model: openai("gpt-5.1"),
      system: SQL_PROMPT,
      prompt: lastUserMessage,
      maxTokens: 200,
      reasoningEffort: "low",
    });

    const rawResponse = (sqlResult.text || "").trim();
    log("SQL model response:", rawResponse);
    log("SQL generation tokens:", sqlResult.usage);

    // Handle unclear/invalid queries
    if (rawResponse.toUpperCase() === "UNCLEAR" || !rawResponse) {
      const clarification = await generateText({
        model: openai("gpt-4.1-nano"),
        system: UNCLEAR_PROMPT,
        prompt: `User message: ${lastUserMessage}`,
        maxTokens: 200,
      });

      const sqlUsage = normalizeUsage(sqlResult.usage);
      const clarUsage = normalizeUsage(clarification.usage);

      return Response.json({
        message:
          clarification.text ||
          "I couldn't understand your question. Please ask something specific about mandi prices.",
        usage: addUsage(sqlUsage, clarUsage),
      });
    }

    const sqlQuery = extractSqlFromResponse(rawResponse);

    if (!sqlQuery) {
      throw new Error("Failed to generate SQL query");
    }
    const safeSqlQuery = sanitizeSql(sqlQuery);

    // Phase 2: Execute SQL via MCP
    mcpClient = await createMCPClient({
      transport: {
        type: "http",
        url: `https://mcp.supabase.com/mcp?project_ref=${projectRef}`,
        headers: { Authorization: `Bearer ${pat}` },
      },
    });

    const mcpTools = await mcpClient.tools();
    if (!mcpTools.execute_sql) {
      throw new Error("MCP did not expose the execute_sql tool");
    }

    const sqlData = await mcpTools.execute_sql.execute({ query: safeSqlQuery });
    const data = extractJsonFromMcpResult(sqlData);

    // Close MCP client early
    if (mcpClient?.close) {
      await mcpClient.close();
      mcpClient = null;
    }

    log("SQL returned", data.length, "rows");

    const sqlUsage = normalizeUsage(sqlResult.usage);

    if (data.length === 0) {
      return Response.json({
        message:
          "No results found for your query. Try checking the commodity name or broadening your search.",
        usage: sqlUsage,
      });
    }

    // Encode data as TOON for efficiency
    const toonData = toToon(data);
    log(
      "TOON:",
      toonData.length,
      "chars vs JSON:",
      JSON.stringify(data).length,
      "chars"
    );

    // Phase 3: Stream the summary
    const summaryResult = streamText({
      model: openai("gpt-4.1-nano"),
      system: SUMMARY_PROMPT,
      prompt: `Question: ${lastUserMessage}\n\nData:\n${toonData}\n\nProvide a helpful, concise answer.`,
      maxTokens: 300,
    });

    const stream = new ReadableStream({
      async start(controller) {
        try {
          let fullText = "";
          for await (const delta of summaryResult.textStream) {
            fullText += delta;
            controller.enqueue(
              encoder.encode(
                `event: delta\ndata:${JSON.stringify({ delta })}\n\n`
              )
            );
          }

          const summaryUsageRaw = await summaryResult.usage.catch(() => ({}));
          const summaryUsage = normalizeUsage(summaryUsageRaw);
          const totalUsage = addUsage(sqlUsage, summaryUsage);

          controller.enqueue(
            encoder.encode(
              `event: done\ndata:${JSON.stringify({
                fullText,
                usage: totalUsage,
              })}\n\n`
            )
          );
          controller.close();
        } catch (err) {
          controller.enqueue(
            encoder.encode(
              `event: error\ndata:${JSON.stringify({
                message: err?.message || "Stream interrupted",
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
        "Transfer-Encoding": "chunked",
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
