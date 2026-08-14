function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return String(value);
  }
  return null;
}

function providerRateLimitError(error) {
  const seen = new Set();
  let current = error;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const status = current.status ?? current.statusCode;
    if (status === 429) return current;
    current = current.response || current.cause;
  }

  return null;
}

export function hasExhaustedDailyProviderCapacity(error) {
  const providerError = providerRateLimitError(error);
  if (!providerError) return false;

  return (
    headerValue(
      providerError.responseHeaders,
      "x-ratelimit-remaining-requests"
    ) === "0"
  );
}

export function getDailyProviderLimitMessage() {
  return "Ask Mandi has used today’s shared AI capacity. Please try again after it resets.";
}
