import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.instance';
import { Agent } from '../entities/agent.entity';
import { Tenant } from '../entities/tenant.entity';
import { RoutingService } from './routing.service';
import { ModelPricingCacheService } from '../model-prices/model-pricing-cache.service';
import { OllamaSyncService } from '../database/ollama-sync.service';
import { expandProviderNames } from './provider-aliases';
import { isCopilotModel } from './proxy/copilot-model-map';
import { trackCloudEvent } from '../common/utils/product-telemetry';
import { AgentNameParamDto, ConnectProviderDto, SetOverrideDto } from './dto/routing.dto';

/**
 * Picker-enabled models available via the GitHub Copilot API.
 * These use the dot-notation IDs that the Copilot /chat/completions endpoint accepts.
 * Sourced from GET https://api.individual.githubcopilot.com/models (model_picker_enabled=true).
 */
const COPILOT_PICKER_MODELS: Array<{
  model_name: string;
  quality_score: number;
  capability_reasoning: boolean;
}> = [
  { model_name: 'gpt-5-mini', quality_score: 1, capability_reasoning: false },
  { model_name: 'gpt-5.1', quality_score: 4, capability_reasoning: false },
  { model_name: 'gpt-5.2', quality_score: 4, capability_reasoning: false },
  { model_name: 'gpt-5.1-codex', quality_score: 4, capability_reasoning: false },
  { model_name: 'gpt-5.1-codex-mini', quality_score: 3, capability_reasoning: false },
  { model_name: 'gpt-5.1-codex-max', quality_score: 5, capability_reasoning: false },
  { model_name: 'gpt-5.2-codex', quality_score: 4, capability_reasoning: false },
  { model_name: 'gpt-5.3-codex', quality_score: 5, capability_reasoning: false },
  { model_name: 'gpt-4.1', quality_score: 3, capability_reasoning: false },
  { model_name: 'gpt-4o', quality_score: 3, capability_reasoning: false },
  { model_name: 'claude-opus-4.6', quality_score: 5, capability_reasoning: true },
  { model_name: 'claude-sonnet-4.6', quality_score: 4, capability_reasoning: true },
  { model_name: 'claude-sonnet-4.5', quality_score: 4, capability_reasoning: true },
  { model_name: 'claude-sonnet-4', quality_score: 4, capability_reasoning: true },
  { model_name: 'claude-opus-4.5', quality_score: 5, capability_reasoning: true },
  { model_name: 'claude-haiku-4.5', quality_score: 2, capability_reasoning: false },
  { model_name: 'gemini-3.1-pro-preview', quality_score: 5, capability_reasoning: true },
  { model_name: 'gemini-3-pro-preview', quality_score: 4, capability_reasoning: true },
  { model_name: 'gemini-3-flash-preview', quality_score: 3, capability_reasoning: false },
  { model_name: 'gemini-2.5-pro', quality_score: 4, capability_reasoning: true },
  { model_name: 'grok-code-fast-1', quality_score: 3, capability_reasoning: false },
];

@Controller('api/v1/routing')
export class RoutingController {
  constructor(
    private readonly routingService: RoutingService,
    private readonly pricingCache: ModelPricingCacheService,
    private readonly ollamaSync: OllamaSyncService,
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
  ) {}

  private async resolveAgent(userId: string, agentName: string): Promise<Agent> {
    const tenant = await this.tenantRepo.findOne({ where: { name: userId } });
    if (!tenant) throw new NotFoundException(`Tenant not found`);
    const agent = await this.agentRepo.findOne({
      where: { tenant_id: tenant.id, name: agentName },
    });
    if (!agent) throw new NotFoundException(`Agent "${agentName}" not found`);
    return agent;
  }

  /* ── Status ── */

  @Get(':agentName/status')
  async getStatus(@CurrentUser() user: AuthUser, @Param() params: AgentNameParamDto) {
    const agent = await this.resolveAgent(user.id, params.agentName);
    const providers = await this.routingService.getProviders(agent.id);
    const enabled = providers.some((p) => p.is_active);
    return { enabled };
  }

  /* ── Providers ── */

  @Get(':agentName/providers')
  async getProviders(@CurrentUser() user: AuthUser, @Param() params: AgentNameParamDto) {
    const agent = await this.resolveAgent(user.id, params.agentName);
    const providers = await this.routingService.getProviders(agent.id);
    return providers.map((p) => ({
      id: p.id,
      provider: p.provider,
      is_active: p.is_active,
      has_api_key: !!p.api_key_encrypted,
      key_prefix: this.routingService.getKeyPrefix(p.api_key_encrypted),
      connected_at: p.connected_at,
    }));
  }

  @Post(':agentName/providers')
  async upsertProvider(
    @CurrentUser() user: AuthUser,
    @Param() params: AgentNameParamDto,
    @Body() body: ConnectProviderDto,
  ) {
    const agent = await this.resolveAgent(user.id, params.agentName);

    // Sync Ollama models before connecting so tier assignment has data
    if (body.provider.toLowerCase() === 'ollama') {
      await this.ollamaSync.sync();
    }

    const { provider: result, isNew } = await this.routingService.upsertProvider(
      agent.id,
      user.id,
      body.provider,
      body.apiKey,
    );

    if (isNew) {
      trackCloudEvent('routing_provider_connected', user.id, {
        provider: body.provider,
      });
    }

    return {
      id: result.id,
      provider: result.provider,
      is_active: result.is_active,
    };
  }

  @Post(':agentName/providers/deactivate-all')
  async deactivateAllProviders(@CurrentUser() user: AuthUser, @Param() params: AgentNameParamDto) {
    const agent = await this.resolveAgent(user.id, params.agentName);
    await this.routingService.deactivateAllProviders(agent.id);
    return { ok: true };
  }

  @Delete(':agentName/providers/:provider')
  async removeProvider(
    @CurrentUser() user: AuthUser,
    @Param('agentName') agentName: string,
    @Param('provider') provider: string,
  ) {
    const agent = await this.resolveAgent(user.id, agentName);
    const { notifications } = await this.routingService.removeProvider(agent.id, provider);
    return { ok: true, notifications };
  }

  /* ── Ollama sync ── */

  @Post(':agentName/ollama/sync')
  async syncOllama(@Param() params: AgentNameParamDto) {
    // Allow syncing a specific agent's Ollama models; fallback to global sync if needed
    return this.ollamaSync.sync();
  }

  /* ── Tiers ── */

  @Get(':agentName/tiers')
  async getTiers(@CurrentUser() user: AuthUser, @Param() params: AgentNameParamDto) {
    const agent = await this.resolveAgent(user.id, params.agentName);
    return this.routingService.getTiers(agent.id, user.id);
  }

  @Put(':agentName/tiers/:tier')
  async setOverride(
    @CurrentUser() user: AuthUser,
    @Param('agentName') agentName: string,
    @Param('tier') tier: string,
    @Body() body: SetOverrideDto,
  ) {
    const agent = await this.resolveAgent(user.id, agentName);
    return this.routingService.setOverride(agent.id, user.id, tier, body.model);
  }

  @Delete(':agentName/tiers/:tier')
  async clearOverride(
    @CurrentUser() user: AuthUser,
    @Param('agentName') agentName: string,
    @Param('tier') tier: string,
  ) {
    const agent = await this.resolveAgent(user.id, agentName);
    await this.routingService.clearOverride(agent.id, tier);
    return { ok: true };
  }

  @Post(':agentName/tiers/reset-all')
  async resetAllOverrides(@CurrentUser() user: AuthUser, @Param() params: AgentNameParamDto) {
    const agent = await this.resolveAgent(user.id, params.agentName);
    await this.routingService.resetAllOverrides(agent.id);
    return { ok: true };
  }

  /* ── Available models ── */

  @Get(':agentName/available-models')
  async getAvailableModels(@CurrentUser() user: AuthUser, @Param() params: AgentNameParamDto) {
    const agent = await this.resolveAgent(user.id, params.agentName);
    const providers = await this.routingService.getProviders(agent.id);
    const activeProviders = expandProviderNames(
      providers.filter((p) => p.is_active).map((p) => p.provider),
    );

    const models = this.pricingCache.getAll();

    // Base set: canonical provider models filtered by active providers
    const base = models
      .filter((m) => activeProviders.has(m.provider.toLowerCase()))
      .map((m) => ({
        model_name: m.model_name,
        provider: m.provider,
        input_price_per_token: m.input_price_per_token,
        output_price_per_token: m.output_price_per_token,
        context_window: m.context_window,
        capability_reasoning: m.capability_reasoning,
        capability_code: m.capability_code,
        quality_score: m.quality_score,
      }));

    // If the user has a GitHub Copilot connection, also expose a Copilot group
    const hasCopilot = providers.some(
      (p) => p.is_active && p.provider.toLowerCase() === 'github-copilot',
    );
    if (hasCopilot) {
      const copilotEntries = COPILOT_PICKER_MODELS.map((m) => ({
        model_name: m.model_name,
        provider: 'GitHub Copilot',
        input_price_per_token: 0,
        output_price_per_token: 0,
        context_window: 200000,
        capability_reasoning: m.capability_reasoning,
        capability_code: true,
        quality_score: m.quality_score,
      }));

      // Return canonical models + the Copilot group
      return base.concat(copilotEntries);
    }

    return base;
  }
}
