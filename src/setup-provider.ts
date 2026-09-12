/** Endpoint overrides belong to a provider, not to the next provider selected. */
export function setMainProvider(env: Record<string, string>, provider: string): void {
  if (env.LLM_PROVIDER !== provider) {
    delete env.LLM_BASE_URL;
  }
  env.LLM_PROVIDER = provider;
}
