/**
 * Maps standard model names (as they appear in Manifest's pricing DB)
 * to their availability on GitHub Copilot.
 *
 * Copilot uses the same model names but may strip or add prefixes.
 * This map tracks which models are known to work through the Copilot API.
 */

/** Known models available on GitHub Copilot (updated 2026-03-02). */
const COPILOT_MODELS = new Set([
  // OpenAI
  'gpt-4o',
  'gpt-4.1',
  'gpt-5-mini',
  'gpt-5',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-mini',
  'gpt-5.1-codex-max',
  'gpt-5.2',
  'gpt-5.2-codex',

  // Anthropic
  'claude-haiku-4.5',
  'claude-sonnet-4',
  'claude-sonnet-4.5',
  'claude-sonnet-4.6',
  'claude-opus-4.5',
  'claude-opus-4.6',

  // Google
  'gemini-2.5-pro',
  'gemini-3-pro-preview',
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview',

  // xAI
  'grok-code-fast-1',
]);

/**
 * Check if a model name is available on GitHub Copilot.
 *
 * Handles the `github-copilot/model-name` prefix that OpenClaw uses,
 * as well as bare model names from Manifest's pricing DB.
 */
export function isCopilotModel(modelName: string): boolean {
  const bare = stripCopilotPrefix(modelName);
  return COPILOT_MODELS.has(bare);
}

/**
 * Strip the `github-copilot/` prefix if present.
 */
export function stripCopilotPrefix(modelName: string): string {
  return modelName.startsWith('github-copilot/')
    ? modelName.slice('github-copilot/'.length)
    : modelName;
}

/**
 * Get all known Copilot model names.
 */
export function getCopilotModels(): ReadonlySet<string> {
  return COPILOT_MODELS;
}
