import test from "node:test";
import assert from "node:assert/strict";

import {
  getDailyProviderLimitMessage,
  hasExhaustedDailyProviderCapacity,
} from "../src/lib/provider-error.mjs";

test("identifies only an exhausted daily provider allowance", () => {
  assert.equal(
    hasExhaustedDailyProviderCapacity({
      statusCode: 429,
      responseHeaders: { "x-ratelimit-remaining-requests": "0" },
    }),
    true
  );
  assert.equal(
    hasExhaustedDailyProviderCapacity({
      status: 429,
      responseHeaders: { "x-ratelimit-remaining-requests": "841" },
    }),
    false
  );
  assert.equal(
    getDailyProviderLimitMessage(),
    "Ask Mandi has used today’s shared AI capacity. Please try again after it resets."
  );
});
