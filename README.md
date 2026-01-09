# askmandi

a chat interface that lets you talk to mandi (indian agriculture market) data in plain language.

<img width="1416" height="987" alt="Screenshot 2026-01-09 at 8 10 19 PM" src="https://github.com/user-attachments/assets/1ab18ba8-453c-4b4d-a3d1-310e1d382d32" />

## why i built it

i recently found out that the government of india maintains open datasets across various sectors. most people can't access this data because it requires knowing sql or some other tool.

so i thought it'd be a fun side project to build a chat interface that lets you talk to this data in plain language and get answers. i asked chatgpt to find me the best datasets and we settled on the agriculture market data.

the idea was to build something where an ai agent could autonomously understand what you're asking, decide what data to fetch, run the queries independently and then return answers all without hand holding. this was a good excuse for me to learn how to integrate mcp into a real project.

## tech stack

- next.js
- tailwindcss
- supabase + mcp
- upstash redis

## quickstart

1. clone the repo:

   ```bash
   git clone https://github.com/rittikbasu/askmandi.git
   cd askmandi
   ```

2. install deps:

   ```bash
   npm install
   ```

3. create your `.env.local` with:

   ```bash
   OPENAI_API_KEY=...

   # supabase mcp
   SUPABASE_PROJECT_REF=...
   SUPABASE_PAT=...

   # upstash kv (rate limit + cache)
   KV_REST_API_URL=...
   KV_REST_API_TOKEN=...
   ```

4. run:

   ```bash
   npm run dev
   ```

5. to setup up the db and fetch data run the companion [python script](https://github.com/rittikbasu/mandi_price_fetcher)

## what it does

- turns your question into **sql**
- runs it against the database (via supabase mcp)
- streams back a clean answer (and logs token + cost)

## how i keep token usage low

- **small selects**: i nudge the sql generator to only select columns needed for the answer
- **two-model setup**: use a stronger model for sql generation (`gpt-4.1-mini`) and a cheaper one for summarizing the results (`gpt-4.1-nano`)
- **location-first**: resolve state/district before generating sql so we don’t run “try again” queries
- **toon encoding**: query results are sent to the summarizer as toon (about 50%-55% reduction in tokens)
- **deterministic summaries**: summary model runs with `temperature: 0` to reduce weird reruns and inconsistent answers
- **cache until refresh**: same question is cached until the next data refresh so repeat traffic is basically free
- **rate limit**: 10 questions per visitor per 24h to stop prevent abuse
- **cost logging**: every request prints token + $ cost in server logs so you can spot expensive prompts fast

## contributing

want to contribute? open a pr — bug fixes, smarter sql prompts, cheaper token usage or ui polish are all welcome.
