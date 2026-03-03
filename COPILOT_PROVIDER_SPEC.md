# GitHub Copilot Provider — Design Spec

## Goal
Add `github-copilot` as a first-class provider in Manifest with **provider preference** semantics:
when Manifest's scorer picks a model that's available on GitHub Copilot, route through Copilot first
(included in subscription). If Copilot returns a quota error (429), automatically retry with the
direct provider (OpenAI, Anthropic, etc.).

## Architecture

### How Manifest Routes Today
1. Scorer analyzes messages → assigns a **tier** (simple/standard/complex/reasoning)
2. Tier maps to a **model** (e.g. `claude-sonnet-4.5`) via `tier_assignment` table
3. Model's **provider** is looked up from pricing DB (e.g. `anthropic`)
4. Provider's **API key** is fetched → request forwarded to provider endpoint

### What Changes
A new layer between step 3 and 4: **Provider Preference**.

After resolving model + provider, check if `github-copilot` is connected AND the model is available
on Copilot. If both conditions are met, try Copilot first. On 429/quota exhaustion, fall back to the
original provider transparently.

### Components

#### 1. `copilot-token.service.ts` (new)
- Manages GitHub Copilot JWT lifecycle
- Exchanges GitHub PAT → short-lived Copilot API token
- Caches token, refreshes 5 min before expiry
- Derives `baseUrl` from token's `proxy-ep` field
- Injectable NestJS service

#### 2. `provider-endpoints.ts` (modified)
- Add `github-copilot` entry (OpenAI-compatible format)
- Dynamic baseUrl from CopilotTokenService
- Dynamic auth header from cached JWT

#### 3. `copilot-model-map.ts` (new)
- Maps standard model names to Copilot availability
- e.g. `claude-sonnet-4.5` → available on Copilot as `claude-sonnet-4.5`
- Hardcoded initial list based on Ian's config, with refresh mechanism

#### 4. `proxy.service.ts` (modified)
- After resolve, check copilot availability
- Try copilot first → on 429/5xx → retry with original provider
- Log which provider actually served the request
- Return correct provider name in `X-Manifest-Provider` header

#### 5. `provider-aliases.ts` (modified)
- Add `github-copilot` alias

#### 6. `routing.service.ts` (modified)
- `getProviderApiKey()` for github-copilot returns the cached JWT (not a static key)

### Copilot Token Flow
```
GitHub PAT (long-lived)
  → POST api.github.com/copilot_internal/v2/token
  → { token: "tid=...", expires_at: 1234567890 }
  → Cache token, use as Bearer auth
  → Derive baseUrl from token's proxy-ep field
  → Default: https://api.individual.githubcopilot.com
```

### Model Availability on Copilot
Based on Ian's current config, these models are available:
- gpt-5-mini, gpt-4.1, gpt-4o, gpt-5, gpt-5.1, gpt-5.2 (OpenAI)
- claude-opus-4.5, claude-opus-4.6, claude-sonnet-4, claude-sonnet-4.5, claude-sonnet-4.6, claude-haiku-4.5 (Anthropic)
- gemini-2.5-pro, gemini-3-pro-preview, gemini-3-flash-preview, gemini-3.1-pro-preview (Google)
- grok-code-fast-1 (xAI)

### Quota Detection
- HTTP 429 from Copilot API → quota exceeded → fall back
- Track quota state per-model or globally to avoid repeated 429s
- Optional: respect `Retry-After` header for timed recovery

### Config
The GitHub PAT is passed via `user_provider.api_key_encrypted` when the user connects
`github-copilot` as a provider. The Copilot token exchange happens internally.

## Non-Goals (v1)
- No changes to the scorer/tier logic
- No copilot-specific pricing entries (copilot is "free" via subscription)
- No UI changes to the Manifest dashboard (provider connects via API/CLI)
