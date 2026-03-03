/**
 * Maps between frontend provider IDs and pricing-DB provider names.
 * E.g. the user connects "gemini" but pricing rows use "Google".
 *
 * GitHub Copilot proxies models from multiple underlying providers
 * (OpenAI, Anthropic, Google, xAI). When resolving whether a model's
 * provider is "connected", treat github-copilot as a valid match for
 * any provider whose models it supports — and vice versa.
 */
const ALIASES: Record<string, string[]> = {
  // Google / Gemini
  gemini: ['google', 'github-copilot'],
  google: ['gemini', 'github-copilot'],
  // Alibaba / Qwen
  qwen: ['alibaba'],
  alibaba: ['qwen'],
  moonshot: ['moonshot'],
  minimax: ['minimax'],
  zai: ['zai', 'z.ai'],
  'z.ai': ['zai'],
  // xAI — also available via Copilot
  xai: ['github-copilot'],
  ollama: ['ollama'],
  // Anthropic — also available via Copilot
  anthropic: ['github-copilot'],
  // GitHub Copilot proxies OpenAI, Anthropic, Google, xAI
  'github-copilot': ['copilot', 'openai', 'anthropic', 'google', 'xai'],
  copilot: ['github-copilot'],
};

/** Expand a set of provider names to include known aliases. */
export function expandProviderNames(names: Iterable<string>): Set<string> {
  const expanded = new Set<string>();
  for (const name of names) {
    const lower = name.toLowerCase();
    expanded.add(lower);
    for (const alias of ALIASES[lower] ?? []) {
      expanded.add(alias);
    }
  }
  return expanded;
}
