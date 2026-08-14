export function extractSql(text) {
  if (!text) return null;

  let sql = String(text).trim();
  const completeFence = sql.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (completeFence) sql = completeFence[1];
  else sql = sql.replace(/^```(?:sql)?\s*/i, "").replace(/`+\s*$/, "");

  return sql.trim() || null;
}

function executableSql(sql) {
  let code = "";
  let index = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        code += "\n";
      }
      index += 1;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 2;
      } else index += 1;
      continue;
    }
    if (quote) {
      if (char === quote && next === quote) {
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      code += " ";
      index += 1;
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      index += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 2;
      continue;
    }
    code += char;
    index += 1;
  }

  return quote || blockComment ? null : code;
}

function hasTopLevelOr(code) {
  let depth = 0;
  const tokens = String(code || "").match(/\(|\)|\bOR\b/gi) || [];
  for (const token of tokens) {
    if (token === "(") depth += 1;
    else if (token === ")") depth = Math.max(0, depth - 1);
    else if (token.toUpperCase() === "OR" && depth === 0) return true;
  }
  return false;
}

export function isSafeSelect(sql) {
  const code = executableSql(String(sql || "").trim());
  if (!code) return false;
  const normalized = code.trim().toLowerCase();
  if (!normalized || (!normalized.startsWith("select") && !normalized.startsWith("with"))) {
    return false;
  }
  if (/[;](?!\s*$)/.test(normalized) || hasTopLevelOr(normalized)) return false;
  return !/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|into|copy|call|do)\b/.test(
    normalized
  );
}
