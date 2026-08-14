export const DEFAULT_MODEL = "openai/gpt-oss-20b";

export function getModelConfig(env = process.env) {
  if (!env.GROQ_API_KEY?.trim()) {
    throw new Error("GROQ_API_KEY is required");
  }

  return {
    baseURL: "https://api.groq.com/openai/v1",
    apiKey: env.GROQ_API_KEY,
    model: env.ASK_MANDI_MODEL?.trim() || DEFAULT_MODEL,
  };
}
