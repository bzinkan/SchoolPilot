/** Production opt-in requires written legal approval and an explicit release decision. */
export function externalAiProvidersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SCHOOLPILOT_EXTERNAL_AI_MODE === "on";
}

/** Guard SDK retries and queued requests at the point where bytes could leave the process. */
export function guardedExternalAiFetch(transport?: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    if (!externalAiProvidersEnabled()) throw new Error("External AI processing is paused");
    return (transport ?? globalThis.fetch)(input, init);
  };
}
