import { Injectable, Logger, BadRequestException, HttpException } from '@nestjs/common';
import { ResolveService } from '../resolve.service';
import { RoutingService } from '../routing.service';
import { ProviderClient, ForwardResult } from './provider-client';
import { SessionMomentumService } from './session-momentum.service';
import { LimitCheckService } from '../../notifications/services/limit-check.service';
import { CopilotTokenService } from './copilot-token.service';
import { isCopilotModel, stripCopilotPrefix } from './copilot-model-map';
import { Tier, ScorerMessage } from '../scorer/types';

/**
 * Roles excluded from scoring. OpenClaw (and similar tools) inject a large,
 * keyword-rich system prompt with every request. Scoring it inflates every
 * request to the most expensive tier. We strip these before the scorer sees
 * them, but forward the full unmodified body to the real provider.
 */
const SCORING_EXCLUDED_ROLES = new Set(['system', 'developer']);
const SCORING_RECENT_MESSAGES = 10;

/** Duration to suppress copilot attempts after a quota 429 */
const COPILOT_QUOTA_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

export interface RoutingMeta {
  tier: Tier;
  model: string;
  provider: string;
  confidence: number;
  reason: string;
  copilotFallback?: boolean;
}

export interface ProxyResult {
  forward: ForwardResult;
  meta: RoutingMeta;
}

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);
  /** Timestamp of last copilot 429 — used to avoid hammering a quota-exceeded endpoint */
  private copilotQuotaBlockedUntil = 0;

  constructor(
    private readonly resolveService: ResolveService,
    private readonly routingService: RoutingService,
    private readonly providerClient: ProviderClient,
    private readonly momentum: SessionMomentumService,
    private readonly limitCheck: LimitCheckService,
    private readonly copilotToken: CopilotTokenService,
  ) {}

  async proxyRequest(
    userId: string,
    body: Record<string, unknown>,
    sessionKey: string,
    tenantId?: string,
    agentName?: string,
    signal?: AbortSignal,
  ): Promise<ProxyResult> {
    const messages = body.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      throw new BadRequestException('messages array is required');
    }

    if (tenantId && agentName) {
      const exceeded = await this.limitCheck.checkLimits(tenantId, agentName);
      if (exceeded) {
        const fmt =
          exceeded.metricType === 'cost'
            ? `$${exceeded.actual.toFixed(2)}`
            : exceeded.actual.toLocaleString();
        const threshFmt =
          exceeded.metricType === 'cost'
            ? `$${exceeded.threshold.toFixed(2)}`
            : exceeded.threshold.toLocaleString();
        throw new HttpException(
          {
            error: {
              message: `Limit exceeded: ${exceeded.metricType} usage (${fmt}) exceeds ${threshFmt} per ${exceeded.period}`,
              type: 'rate_limit_exceeded',
              code: 'limit_exceeded',
            },
          },
          429,
        );
      }
    }

    const recentTiers = this.momentum.getRecentTiers(sessionKey);
    const stream = body.stream === true;

    const scoringMessages = (messages as ScorerMessage[])
      .filter((m) => !SCORING_EXCLUDED_ROLES.has(m.role))
      .slice(-SCORING_RECENT_MESSAGES);

    const isHeartbeat = scoringMessages.some((m) => {
      if (m.role !== 'user') return false;
      if (typeof m.content === 'string') return m.content.includes('HEARTBEAT_OK');
      if (Array.isArray(m.content)) {
        return m.content.some(
          (p: { type?: string; text?: string }) =>
            p.type === 'text' && typeof p.text === 'string' && p.text.includes('HEARTBEAT_OK'),
        );
      }
      return false;
    });

    const resolved = isHeartbeat
      ? await this.resolveService.resolveForTier(userId, 'simple')
      : await this.resolveService.resolve(
          userId,
          scoringMessages,
          undefined,
          undefined,
          body.max_tokens as number | undefined,
          recentTiers,
        );

    if (!resolved.model || !resolved.provider) {
      this.logger.warn(
        `No model available for user=${userId}: ` +
          `tier=${resolved.tier} model=${resolved.model} provider=${resolved.provider} ` +
          `confidence=${resolved.confidence} reason=${resolved.reason}`,
      );
      throw new BadRequestException(
        'No model available. Connect a provider in the Manifest dashboard.',
      );
    }

    // --- Provider Preference: Try GitHub Copilot first ---
    const copilotResult = await this.tryCopilotFirst(userId, resolved.model, body, stream, signal);

    if (copilotResult) {
      this.logger.log(
        `Proxy: tier=${resolved.tier} model=${resolved.model} provider=github-copilot (preferred) confidence=${resolved.confidence}`,
      );
      this.momentum.recordTier(sessionKey, resolved.tier as Tier);
      return {
        forward: copilotResult,
        meta: {
          tier: resolved.tier as Tier,
          model: resolved.model,
          provider: 'github-copilot',
          confidence: resolved.confidence,
          reason: resolved.reason,
        },
      };
    }

    // --- Fallback: Use the original resolved provider ---
    const apiKey = await this.routingService.getProviderApiKey(userId, resolved.provider);
    if (apiKey === null) {
      throw new BadRequestException(
        `No API key found for provider: ${resolved.provider}. Re-connect the provider with an API key.`,
      );
    }

    this.logger.log(
      `Proxy: tier=${resolved.tier} model=${resolved.model} provider=${resolved.provider}` +
        `${copilotResult === null ? ' (copilot fallback)' : ''} confidence=${resolved.confidence}`,
    );

    const extraHeaders: Record<string, string> = {};
    if (resolved.provider === 'xai') {
      extraHeaders['x-grok-conv-id'] = sessionKey;
    }

    const forward = await this.providerClient.forward(
      resolved.provider,
      apiKey,
      resolved.model,
      body,
      stream,
      signal,
      Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
    );

    this.momentum.recordTier(sessionKey, resolved.tier as Tier);

    return {
      forward,
      meta: {
        tier: resolved.tier as Tier,
        model: resolved.model,
        provider: resolved.provider,
        confidence: resolved.confidence,
        reason: resolved.reason,
        copilotFallback: copilotResult === null,
      },
    };
  }

  /**
   * Attempt to forward the request through GitHub Copilot.
   *
   * Returns:
   * - ForwardResult if copilot succeeded
   * - null if copilot was attempted but returned 429 (quota) or other retriable error
   * - undefined if copilot should not be attempted (model not available, no PAT, cooldown)
   */
  private async tryCopilotFirst(
    userId: string,
    model: string,
    body: Record<string, unknown>,
    stream: boolean,
    signal?: AbortSignal,
  ): Promise<ForwardResult | null | undefined> {
    // Check if the model is available on Copilot
    const bareModel = stripCopilotPrefix(model);
    if (!isCopilotModel(bareModel)) {
      return undefined; // Model not on Copilot, skip
    }

    // Check cooldown from recent quota exhaustion
    if (Date.now() < this.copilotQuotaBlockedUntil) {
      this.logger.debug(
        `Copilot quota cooldown active, ${Math.round((this.copilotQuotaBlockedUntil - Date.now()) / 1000)}s remaining`,
      );
      return undefined; // In cooldown, skip
    }

    // Get the GitHub PAT for copilot
    const githubPat = await this.routingService.getProviderApiKey(userId, 'github-copilot');
    if (!githubPat) {
      return undefined; // No copilot PAT configured, skip
    }

    try {
      // Exchange PAT → Copilot JWT
      const { token, baseUrl } = await this.copilotToken.getToken(githubPat);

      // Forward through copilot (uses OpenAI-compatible format)
      const forward = await this.providerClient.forwardWithBaseUrl(
        'github-copilot',
        token,
        bareModel,
        body,
        stream,
        baseUrl,
        signal,
      );

      // Check if the response indicates quota exhaustion
      if (!forward.response.ok) {
        const status = forward.response.status;
        if (status === 429) {
          this.logger.warn(
            `Copilot returned 429 for model=${bareModel}, activating cooldown and falling back`,
          );
          this.copilotQuotaBlockedUntil = Date.now() + COPILOT_QUOTA_COOLDOWN_MS;

          // Parse Retry-After if available
          const retryAfter = forward.response.headers.get('retry-after');
          if (retryAfter) {
            const seconds = parseInt(retryAfter, 10);
            if (Number.isFinite(seconds) && seconds > 0) {
              this.copilotQuotaBlockedUntil = Date.now() + seconds * 1000;
            }
          }

          return null; // Signal to fall back
        }

        if (status === 401 || status === 403) {
          this.logger.warn(`Copilot auth failed (${status}), invalidating token`);
          this.copilotToken.invalidate();
          return null; // Fall back
        }

        // Other errors (5xx, etc.) — fall back
        this.logger.warn(`Copilot returned ${status} for model=${bareModel}, falling back`);
        return null;
      }

      return forward; // Success!
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Copilot attempt failed: ${msg}, falling back to direct provider`);
      return null; // Fall back on any error
    }
  }
}
