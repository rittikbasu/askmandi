export const dynamic = "force-dynamic";

const PROMPT = "Where are apples the cheapest today?";
const BASE_URL = "https://askmandi.vercel.app";

export async function GET(_req) {
  try {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: PROMPT }],
      }),
      cache: "no-store",
      next: { revalidate: 0 },
    });

    if (!res.ok) {
      return Response.json({ ok: false, status: res.status }, { status: 500 });
    }

    return Response.json({ ok: true, status: res.status });
  } catch (err) {
    return Response.json(
      { ok: false, error: err?.message || "Cron invocation failed" },
      { status: 500 }
    );
  }
}
