const PRICE_FIELD = /(^|_)price($|_)/;
const INTERNAL_FIELDS = new Set(["variety", "grade"]);

function asRupeesPerKg(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return Math.round((numeric / 100) * 100) / 100;
}

// Database prices are rupees per quintal. Convert before giving data to the
// language model so presentation cannot silently change the unit.
export function prepareDisplayRows(rows) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row)
        .filter(([key]) => !INTERNAL_FIELDS.has(key))
        .map(([key, value]) => [
          key,
          PRICE_FIELD.test(key) ? asRupeesPerKg(value) : value,
        ])
    )
  );
}
