import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const SYSTEM_PROMPT = `You answer questions about commodity prices from Indian agricultural markets (mandis).

## Database
Table: mandi_prices
Columns: id, arrival_date (date), state, district, market, commodity, variety, grade, min_price, max_price, modal_price (all prices in ₹/quintal)

## Query Rules
- Always filter: WHERE arrival_date = (SELECT MAX(arrival_date) FROM mandi_prices)
- Case-insensitive: commodity ILIKE '%tomato%'
- Limit results: LIMIT 10 for lists
- Use modal_price for "price" comparisons (most common trading price)

## Price Format
- Raw data is ₹/quintal (100 kg). Show as ₹/kg when practical (divide by 100).
- Example: 2500/quintal = ₹25/kg

## Commodity Names
Users may use colloquial names. Map to these official names in the database:
Vegetables: amaranthus, ashgourd, beans, beetroot, bhindi(ladies finger), bitter gourd, bottle gourd, brinjal, bunch beans, cabbage, capsicum, carrot, cauliflower, chow chow, cluster beans, colacasia, coriander(leaves), cowpea(veg), cucumbar(kheera), drumstick, elephant yam(suran), french beans(frasbean), garlic, ginger(green), green chilli, green peas, knool khol, ladies finger, leafy vegetable, lemon, lime, little gourd(kundru), long melon(kakri), methi(leaves), mint(pudina), mushrooms, onion, onion green, peas cod, peas wet, pointed gourd(parval), potato, pumpkin, raddish, ridgeguard(tori), round gourd, season leaves, snake gourd, spinach, sponge gourd, squash, sweet potato, taro leaves, tinda, tomato, turnip, yam(ratalu)
Fruits: amla, apple, banana, banana - green, ber, chikoos(sapota), custard apple, grapes, guava, jack fruit, karbuja(musk melon), kinnow, kiwi, mango, mango(raw-ripe), mousambi(sweet lime), orange, papaya, papaya(raw), pear, pineapple, plum, pomegranate, tamarind fruit, water melon
Grains & Pulses: arhar dal, arhar(tur/red gram), bajra(pearl millet), barley(jau), bengal gram dal, bengal gram(whole), black gram dal, black gram(urd), foxtail millet, green gram dal, green gram(moong), jowar(sorghum), kabuli chana, kulthi(horse gram), lentil(masur), maize, paddy(basmati), paddy(common), ragi(finger millet), red gram, rice, wheat, white peas
Spices: ajwan, black pepper, chili red, dry chillies, coriander seed, cummin seed(jeera), ginger(dry), methi seeds, mustard, pepper garbled, poppy seeds, turmeric
Oilseeds: castor seed, coconut, copra, groundnut, linseed, safflower, sesamum(til), soyabean, sunflower
Cash Crops: arecanut(supari), betel leaves, coffee, cotton, gur(jaggery), jaggery, jute, rubber, sugarcane, tapioca

## Response Style
- Be concise, use markdown to format the response where appropriate
- If no results, suggest checking commodity spelling or trying related terms`;

const log = (...args) => console.log("[api/chat]", ...args);

function isReadOnlyQuery(query) {
  if (typeof query !== "string") return false;
  // Allow SELECT and CTEs ("WITH ... SELECT ...")
  return /^\s*(select|with)\b/i.test(query);
}

function usageFromGenerateTextResult(r) {
  const u = r?.usage;
  if (
    u &&
    (typeof u.inputTokens === "number" || typeof u.outputTokens === "number")
  ) {
    const inputTokens = u.inputTokens || 0;
    const outputTokens = u.outputTokens || 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }

  // Fallback: aggregate from steps if available
  let inputTokens = 0;
  let outputTokens = 0;
  for (const step of r?.steps || []) {
    if (step?.usage) {
      inputTokens += step.usage.inputTokens || 0;
      outputTokens += step.usage.outputTokens || 0;
    }
  }
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function addUsage(a, b) {
  const ai = a?.inputTokens || 0;
  const ao = a?.outputTokens || 0;
  const bi = b?.inputTokens || 0;
  const bo = b?.outputTokens || 0;
  return {
    inputTokens: ai + bi,
    outputTokens: ao + bo,
    totalTokens: ai + bi + ao + bo,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { messages } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Messages array is required" });
  }

  log("Incoming request", {
    messageCount: messages.length,
    lastUser:
      [...messages].reverse().find((m) => m?.role === "user")?.content || null,
  });

  let mcpClient = null;
  const sqlQueries = [];

  try {
    const projectRef = process.env.SUPABASE_PROJECT_REF;

    if (!projectRef) {
      throw new Error("SUPABASE_PROJECT_REF is not configured");
    }

    mcpClient = await createMCPClient({
      transport: {
        type: "http",
        url: `https://mcp.supabase.com/mcp?project_ref=${projectRef}`,
        headers: {
          Authorization: `Bearer ${process.env.SUPABASE_PAT}`,
        },
      },
    });

    const mcpTools = await mcpClient.tools();

    if (!mcpTools.execute_sql) {
      throw new Error("MCP did not expose the execute_sql tool");
    }

    // Wrap execute_sql to capture queries and results
    const sqlResults = [];
    const tools = {
      execute_sql: {
        ...mcpTools.execute_sql,
        execute: async (args) => {
          const query = args?.query;
          if (query) {
            if (!isReadOnlyQuery(query)) {
              throw new Error(
                "Blocked non-read-only SQL. Only SELECT queries are allowed."
              );
            }
            sqlQueries.push(query);
            log("Executing SQL", query);
          }
          const result = await mcpTools.execute_sql.execute(args);
          log("Raw SQL result type:", typeof result);
          log(
            "Raw SQL result:",
            JSON.stringify(result, null, 2).slice(0, 2000)
          );
          sqlResults.push({ query, result });
          return result;
        },
      },
    };

    const result = await generateText({
      model: openai("gpt-5-nano"),
      tools,
      system: SYSTEM_PROMPT,
      messages,
      maxSteps: 10,
    });
    const usagePrimary = usageFromGenerateTextResult(result);

    log("Primary generation finished", {
      textPresent: Boolean(result.text),
      stepCount: result.steps?.length || 0,
      usage: usagePrimary,
    });

    // Close MCP client
    if (mcpClient?.close) {
      await mcpClient.close();
    }

    // Handle case where tool was called but no final text generated.
    // Some models may stop after tool execution; we do a summarization-only
    // second pass using the captured tool results (tools disabled).
    if (!result.text && result.steps?.length > 0) {
      log("No final text; running summarization fallback");

      // Log raw step structure
      log(
        "Steps toolResults raw:",
        JSON.stringify(
          result.steps.map((s) => s.toolResults),
          null,
          2
        ).slice(0, 3000)
      );

      // Use our captured sqlResults which have the actual data
      log(
        "Captured sqlResults:",
        JSON.stringify(sqlResults, null, 2).slice(0, 2000)
      );

      const lastUserQuestion =
        [...messages].reverse().find((m) => m?.role === "user")?.content ||
        "the user's question";

      const summarizePrompt = `Summarize the SQL results below to answer the user's question.\n\nUser question:\n${lastUserQuestion}\n\nSQL queries executed:\n${sqlQueries
        .map((q, i) => `(${i + 1}) ${q}`)
        .join("\n")}\n\nSQL results (JSON):\n${JSON.stringify(
        sqlResults
      )}\n\nWrite a helpful, concise answer. If results are empty, say so and suggest how to refine the question.`;

      const followUp = await generateText({
        model: openai("gpt-5-nano"),
        system:
          SYSTEM_PROMPT +
          "\n\nYou are now given query outputs. Do NOT call any tools. Use only the provided results.",
        prompt: summarizePrompt,
        maxSteps: 1,
      });
      const usageFallback = usageFromGenerateTextResult(followUp);
      const usage = addUsage(usagePrimary, usageFallback);

      log("Fallback summary result", {
        hasText: Boolean(followUp.text),
        usageFallback,
        usageTotal: usage,
      });

      return res.status(200).json({
        message:
          followUp.text ||
          "I found the data but couldn't generate a summary. Please try rephrasing your question.",
        usage,
      });
    }

    return res.status(200).json({
      message:
        result.text ||
        "I couldn't find an answer. Please try a different question.",
      usage: usagePrimary,
    });
  } catch (error) {
    console.error("[api/chat] Error", error);

    if (mcpClient?.close) {
      try {
        await mcpClient.close();
      } catch {}
    }

    return res.status(500).json({
      error: "Failed to process your question",
      details: error.message,
    });
  }
}
