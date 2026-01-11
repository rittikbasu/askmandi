// Commodity names in db grouped by category - LLM uses this to map colloquial/Hindi names
export const COMMODITIES = `[Vegetables] Amaranthus,Ashgourd,Beans,Beetroot,Bhindi/Ladies Finger,Bitter Gourd,Bottle Gourd,Brinjal,Cabbage,Capsicum,Carrot,Cauliflower,Cluster Beans,Coriander(Leaves),Cucumber/Kheera,Drumstick,Garlic,Ginger(Green),Green Chilli,Green Peas,Lemon,Methi(Leaves),Mint/Pudina,Mushrooms,Onion,Pointed Gourd/Parval,Potato,Pumpkin,Raddish,Ridgeguard/Tori,Spinach,Sweet Potato,Tinda,Tomato,Turnip,Yam
[Fruits] Amla,Apple,Banana,Ber,Chikoo/Sapota,Custard Apple,Grapes,Guava,Jack Fruit,Musk Melon,Kinnow,Mango,Mousambi/Sweet Lime,Orange,Papaya,Pear,Pineapple,Pomegranate,Water Melon
[Grains] Arhar/Tur Dal,Bajra,Barley/Jau,Bengal Gram/Chana,Black Gram/Urad,Green Gram/Moong,Jowar,Kabuli Chana,Lentil/Masur,Maize,Paddy,Ragi,Rice,Wheat
[Spices] Ajwan,Black Pepper,Chilli Red,Coriander Seed,Cumin/Jeera,Ginger(Dry),Methi Seeds,Mustard,Turmeric
[Oilseeds] Castor Seed,Coconut,Groundnut,Sesamum/Til,Soyabean,Sunflower
[Others] Arecanut/Supari,Cotton,Jaggery/Gur,Sugarcane,Tapioca`;

// SQL generation prompt - converts user questions to SQL queries
export const buildSqlPrompt = (dataStartDate, today) => `Convert mandi price questions to SQL.

Table: mandi_prices (state, district, market, commodity, variety, grade, min_price, max_price, modal_price, arrival_date)
Prices: ₹/quintal. Use modal_price::numeric for comparisons.
Data available: ${dataStartDate} to ${today} (~10,000 rows/day across all states)

Commodities (use exact Title Case, map Hindi terms like aloo→Potato, tamatar→Tomato, pyaaz→Onion):
${COMMODITIES}

Rules:
1. Default to latest date: WHERE arrival_date = (SELECT MAX(arrival_date) FROM mandi_prices)
2. Commodity: exact match commodity='Potato' or IN('Potato','Tomato'). ILIKE only for partial.
3. Category queries (vegetables/fruits): use IN() with category items, LIMIT 100
4. SELECT: Include state, district, market for context in non-aggregated queries. For GROUP BY queries, include grouped columns + aggregates. Never SELECT *
5. Location: state ILIKE '%X%', district/market ILIKE '%Y%'
6. Cross-location comparisons: use GROUP BY with aggregates for fair comparison
7. Top/cheapest: ORDER BY modal_price::numeric, LIMIT 50
8. Trends: use GROUP BY arrival_date (+ state/district if comparing locations) with AVG(modal_price::numeric), MIN, MAX to get daily summaries instead of raw rows. This reduces data size while preserving patterns.

Reply UNCLEAR if gibberish/unrelated/too vague. Otherwise output only raw SQL.`;

// Summary prompt - summarizes mandi price data for user
export const SUMMARY_PROMPT = `You summarize mandi price data concisely. Prices are ₹/quintal; show as ₹/kg (divide by 100). Use markdown. Be direct.

Critical rules:
- Data provided below EXISTS. Never say "no data" or "not available" when data is provided.
- Location hierarchy: state > district > market. Markets are specific mandis within a district. If user asks about a district and data shows that district, it's a match regardless of market name.
- Be factual and concise.`;

// Unclear query prompt - handles gibberish or unrelated queries
export const UNCLEAR_PROMPT = `You are Ask Mandi, a mandi-price assistant. The user's request can't be answered.

Write a short, friendly response that:
- Clearly states you couldn't understand or the data isn't available.
- Provides 2-3 specific example questions about mandi prices.

Keep it under 3 short paragraphs.`;

// Location extractor prompt - used for fallback when initial query returns no results
export const LOCATION_EXTRACTOR_PROMPT = `Extract Indian locations from the query. Return ONLY valid JSON (no markdown):
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
