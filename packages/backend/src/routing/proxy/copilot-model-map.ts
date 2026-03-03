/**
 * Models available via the GitHub Copilot API.
 * Source: GET https://api.individual.githubcopilot.com/models
 * Last updated: 2026-03-02
 *
 * These are the canonical model IDs accepted in the Copilot /chat/completions request body.
 */
export const COPILOT_SUPPORTED_MODELS = new Set<string>([
  // Anthropic Claude
  'claude-haiku-4.5',
  'claude-opus-4.5',
  'claude-opus-4.6',
  'claude-opus-4.6-fast',
  'claude-sonnet-4',
  'claude-sonnet-4.5',
  'claude-sonnet-4.6',

  // Google Gemini
  'gemini-2.5-pro',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-3-pro-preview',

  // OpenAI GPT
  'gpt-3.5-turbo',
  'gpt-3.5-turbo-0613',
  'gpt-4',
  'gpt-4-0125-preview',
  'gpt-4-0613',
  'gpt-4.1',
  'gpt-4.1-2025-04-14',
  'gpt-4o',
  'gpt-4o-2024-05-13',
  'gpt-4o-2024-08-06',
  'gpt-4o-2024-11-20',
  'gpt-4o-mini',
  'gpt-4o-mini-2024-07-18',
  'gpt-4-o-preview',
  'gpt-5-mini',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.3-codex',

  // xAI
  'grok-code-fast-1',
]);

/**
 * Strips a "github-copilot/" provider prefix if present.
 * e.g. "github-copilot/claude-sonnet-4.5" → "claude-sonnet-4.5"
 */
export function stripCopilotPrefix(model: string): string {
  return model.startsWith('github-copilot/') ? model.slice('github-copilot/'.length) : model;
}

/**
 * Returns true if the given model ID is available via GitHub Copilot.
 * Checks exact match first, then falls back to prefix matching for versioned IDs
 * (e.g. "claude-sonnet-4.5" matches "claude-sonnet-4.5-20250929").
 */
export function isCopilotModel(model: string): boolean {
  if (!model) return false;
  if (COPILOT_SUPPORTED_MODELS.has(model)) return true;
  // Prefix match: if a Copilot model ID is a prefix of the requested model
  // e.g. "gpt-4o" matches "gpt-4o-2024-11-20"
  for (const supported of COPILOT_SUPPORTED_MODELS) {
    if (model.startsWith(supported + '-') || model.startsWith(supported + '.')) {
      return true;
    }
  }
  return false;
}
