/** Operational compatibility gate; never a school/product permission. */
export function paperworkProcessingVersion(): 1 | 2 {
  const value = process.env.MYDESK_IMPORT_PIPELINE_VERSION ?? "1";
  if (value !== "1" && value !== "2") throw new Error("MYDESK_IMPORT_PIPELINE_VERSION must be 1 or 2");
  return value === "2" ? 2 : 1;
}

/** Serial fallback retains v2 checkpoints and review semantics. */
export function paperworkProcessingWidth(): 1 | 2 {
  const value = process.env.MYDESK_IMPORT_PIPELINE_WIDTH ?? "2";
  if (value !== "1" && value !== "2") throw new Error("MYDESK_IMPORT_PIPELINE_WIDTH must be 1 or 2");
  return value === "1" ? 1 : 2;
}
