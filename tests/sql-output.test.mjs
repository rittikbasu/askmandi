import test from "node:test";
import assert from "node:assert/strict";

import { extractSql, isSafeSelect } from "../src/lib/sql-output.mjs";

test("extracts SQL even when an opening fence is truncated", () => {
  assert.equal(
    extractSql("```sql\nSELECT arrival_date FROM mandi_prices\nWHERE commodity = 'Tomato'"),
    "SELECT arrival_date FROM mandi_prices\nWHERE commodity = 'Tomato'"
  );
});

test("keeps the lightweight SQL guard for valid reads and obvious mutations", () => {
  assert.equal(isSafeSelect("SELECT 1;"), true);
  assert.equal(isSafeSelect("SELECT 1; DROP TABLE mandi_prices;"), false);
  assert.equal(isSafeSelect("SELECT * INTO audit_copy FROM mandi_prices"), false);
});
