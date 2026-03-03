import { Injectable, Logger } from '@nestjs/common';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const COPILOT_CREDENTIAL_PATH = join(
  homedir(),
  '.openclaw',
  'credentials',
  'github-copilot.token.json',
);
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const DEFAULT_COPILOT_API_BASE_URL = 'https://api.individual.githubcopilot.com';
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface CachedToken {
  token: string;
  expiresAt: number;
  baseUrl: string;
}

interface CredentialFile {
  token: string;
  expiresAt: number;
}

/**
 * Manages the GitHub Copilot short-lived JWT lifecycle.
 *
 * Two token sources (in priority order):
 * 1. OpenClaw's credential cache (~/.openclaw/credentials/github-copilot.token.json)
 *    - Already a usable Copilot API JWT, no exchange needed
 *    - OpenClaw manages refreshing this file
 * 2. GitHub PAT → exchange via /copilot_internal/v2/token
 *    - Used when the credential file is missing or expired
 *    - Requires a PAT with Copilot scopes (device flow token, not classic PAT)
 */
@Injectable()
export class CopilotTokenService {
  private readonly logger = new Logger(CopilotTokenService.name);
  private cache: CachedToken | null = null;
  private refreshPromise: Promise<CachedToken> | null = null;

  async getToken(githubPat: string): Promise<{ token: string; baseUrl: string }> {
    // Try the OpenClaw credential file first — it's already a usable JWT
    const fromFile = this.loadFromCredentialFile();
    if (fromFile) {
      return { token: fromFile.token, baseUrl: fromFile.baseUrl };
    }

    // Fall back to in-memory cache from PAT exchange
    if (this.cache && this.isUsable(this.cache)) {
      return { token: this.cache.token, baseUrl: this.cache.baseUrl };
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh(githubPat).finally(() => {
        this.refreshPromise = null;
      });
    }

    const result = await this.refreshPromise;
    return { token: result.token, baseUrl: result.baseUrl };
  }

  invalidate(): void {
    this.cache = null;
  }

  private loadFromCredentialFile(): CachedToken | null {
    try {
      if (!existsSync(COPILOT_CREDENTIAL_PATH)) return null;
      const raw = readFileSync(COPILOT_CREDENTIAL_PATH, 'utf-8');
      const data = JSON.parse(raw) as CredentialFile;
      if (typeof data.token !== 'string' || !data.token) return null;
      if (typeof data.expiresAt !== 'number') return null;
      if (!this.isUsableMs(data.expiresAt)) return null;

      const baseUrl = this.deriveBaseUrl(data.token);
      return { token: data.token, expiresAt: data.expiresAt, baseUrl };
    } catch {
      return null;
    }
  }

  private isUsable(cached: CachedToken): boolean {
    return this.isUsableMs(cached.expiresAt);
  }

  private isUsableMs(expiresAt: number): boolean {
    return expiresAt - Date.now() > REFRESH_BUFFER_MS;
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
