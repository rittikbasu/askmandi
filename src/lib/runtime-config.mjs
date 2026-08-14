export function shouldBypassVisitorRateLimit(env = process.env) {
  return env.NODE_ENV === "development";
}
