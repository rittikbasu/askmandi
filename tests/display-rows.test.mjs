import test from "node:test";
import assert from "node:assert/strict";

import { prepareDisplayRows } from "../src/lib/display-rows.mjs";

test("converts all database price fields from rupees per quintal to rupees per kg", () => {
  assert.deepEqual(
    prepareDisplayRows([
      {
        market: "Example",
        min_price: "800",
        modal_price: "1058.33",
        max_price: "1266.67",
        avg_price: "890.857",
        variety: "Other",
        grade: "FAQ",
        arrival_date: "2026-08-13",
      },
    ]),
    [
      {
        market: "Example",
        min_price: 8,
        modal_price: 10.58,
        max_price: 12.67,
        avg_price: 8.91,
        arrival_date: "2026-08-13",
      },
    ]
  );
});

test("preserves non-price data and non-numeric price values", () => {
  assert.deepEqual(
    prepareDisplayRows([{ state: "Delhi", modal_price: "unknown" }]),
    [{ state: "Delhi", modal_price: "unknown" }]
  );
});
