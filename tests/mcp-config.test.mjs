import test from "node:test";
import assert from "node:assert/strict";

import { buildReadOnlyMcpUrl } from "../src/lib/mcp-config.mjs";

const PROJECT_REF = "abcdefghijklmnopqrst";

test("scopes Supabase MCP to the project and its read-only role", () => {
  assert.equal(
    buildReadOnlyMcpUrl(PROJECT_REF),
    "https://mcp.supabase.com/mcp?project_ref=abcdefghijklmnopqrst&read_only=true"
  );
});

test("preserves existing supported MCP feature options while enforcing read-only", () => {
  assert.equal(
    buildReadOnlyMcpUrl(`${PROJECT_REF}&read_only=false&features=database`),
    "https://mcp.supabase.com/mcp?project_ref=abcdefghijklmnopqrst&read_only=true&features=database"
  );
});

test("rejects a missing or malformed project reference", () => {
  assert.throws(() => buildReadOnlyMcpUrl(""), /project reference is required/);
  assert.throws(() => buildReadOnlyMcpUrl("project ref"), /project reference is invalid/);
});
