export function buildReadOnlyMcpUrl(config) {
  if (!config?.trim()) {
    throw new Error("Supabase project reference is required");
  }

  const [projectRef, ...optionParts] = config.trim().split("&");
  if (!/^[a-z]{20}$/.test(projectRef)) {
    throw new Error("Supabase project reference is invalid");
  }

  const existingOptions = new URLSearchParams(optionParts.join("&"));
  const params = new URLSearchParams({
    project_ref: projectRef,
    read_only: "true",
  });
  const features = existingOptions.get("features");
  if (features) params.set("features", features);

  return `https://mcp.supabase.com/mcp?${params}`;
}
