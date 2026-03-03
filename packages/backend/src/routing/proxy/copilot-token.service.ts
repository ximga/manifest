import { Injectable, Logger } from '@nestjs/common';

const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const DEFAULT_COPILOT_API_BASE_URL = 'https://api.individual.githubcopilot.com';
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before expiry

interface CachedToken {
  token: string;
  expiresAt: number;
  baseUrl: string;
}

/**
 * Manages the GitHub Copilot short-lived JWT lifecycle.
 *
 * GitHub Copilot uses a two-step auth flow:
 * 1. Long-lived GitHub PAT (Personal Access Token)
 * 2. Exchange PAT → short-lived JWT via /copilot_internal/v2/token
 *
 * The JWT is used as Bearer auth for the Copilot chat completions API.
 * The token response may include a `proxy-ep` field that specifies the
 * correct API base URL for the user's Copilot plan.
 */
@Injectable()
export class CopilotTokenService {
  private readonly logger = new Logger(CopilotTokenService.name);
  private cache: CachedToken | null = null;
  private refreshPromise: Promise<CachedToken> | null = null;

  /**
   * Get a usable Copilot API token, refreshing if needed.
   * Returns { token, baseUrl } or throws on failure.
   */
  async getToken(githubPat: string): Promise<{ token: string; baseUrl: string }> {
    if (this.cache && this.isUsable(this.cache)) {
      return { token: this.cache.token, baseUrl: this.cache.baseUrl };
    }

    // Coalesce concurrent refresh attempts
    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh(githubPat).finally(() => {
        this.refreshPromise = null;
      });
    }

    const result = await this.refreshPromise;
    return { token: result.token, baseUrl: result.baseUrl };
  }

  /**
   * Invalidate the cached token (e.g. after a 401 from the Copilot API).
   */
  invalidate(): void {
    this.cache = null;
  }

  private isUsable(cached: CachedToken): boolean {
    return cached.expiresAt - Date.now() > REFRESH_BUFFER_MS;
  }

  private async refresh(githubPat: string): Promise<CachedToken> {
    this.logger.debug('Exchanging GitHub PAT for Copilot API token');

    const res = await fetch(COPILOT_TOKEN_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${githubPat}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Copilot token exchange failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }

    const json = (await res.json()) as Record<string, unknown>;
    const token = json.token;
    const expiresAt = json.expires_at;

    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new Error('Copilot token response missing token');
    }

    let expiresAtMs: number;
    if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) {
      expiresAtMs = expiresAt > 1e10 ? expiresAt : expiresAt * 1000;
    } else if (typeof expiresAt === 'string') {
      const parsed = Number.parseInt(expiresAt, 10);
      if (!Number.isFinite(parsed)) throw new Error('Invalid expires_at');
      expiresAtMs = parsed > 1e10 ? parsed : parsed * 1000;
    } else {
      throw new Error('Copilot token response missing expires_at');
    }

    const baseUrl = this.deriveBaseUrl(token);

    const cached: CachedToken = { token, expiresAt: expiresAtMs, baseUrl };
    this.cache = cached;

    this.logger.log(
      `Copilot token refreshed, expires in ${Math.round((expiresAtMs - Date.now()) / 60000)}m, baseUrl=${baseUrl}`,
    );

    return cached;
  }

  /**
   * Extract the API base URL from the token's proxy-ep field.
   * Token format: "tid=...;proxy-ep=proxy.individual.githubcopilot.com;..."
   */
  private deriveBaseUrl(token: string): string {
    const match = token.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
    if (!match?.[1]) return DEFAULT_COPILOT_API_BASE_URL;

    const host = match[1]
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/^proxy\./i, 'api.');
    return host ? `https://${host}` : DEFAULT_COPILOT_API_BASE_URL;
  }
}
