import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import { existsSync } from 'fs';
import { appConfig } from './config/app.config';
import { DASHBOARD_CACHE_TTL_MS } from './common/constants/cache.constants';
import { ApiKeyGuard } from './common/guards/api-key.guard';
import { ApiKey } from './entities/api-key.entity';
import { SessionGuard } from './auth/session.guard';
import { LocalAuthGuard } from './auth/local-auth.guard';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { SecurityModule } from './security/security.module';
import { OtlpModule } from './otlp/otlp.module';
import { ModelPricesModule } from './model-prices/model-prices.module';
import { NotificationsModule } from './notifications/notifications.module';
import { RoutingModule } from './routing/routing.module';
import { CommonModule } from './common/common.module';
import { SseModule } from './sse/sse.module';
import { GithubModule } from './github/github.module';

const isLocalMode = process.env['MANIFEST_MODE'] === 'local';
const sessionGuardClass = isLocalMode ? LocalAuthGuard : SessionGuard;

// Resolve the frontend path at module load time.
// MANIFEST_FRONTEND_DIR is set by server.js before requiring this module.
// Fallback candidates in priority order:
//   1. MANIFEST_FRONTEND_DIR env var (set by server.js)
//   2. dist/../public  (openclaw-plugin layout: public/ lives next to dist/)
//   3. dist/../../frontend/dist  (standalone/dev layout)
function resolveFrontendPath(): string {
  if (process.env['MANIFEST_FRONTEND_DIR']) {
    return process.env['MANIFEST_FRONTEND_DIR'];
  }
  // In the openclaw-plugin layout the compiled backend lives at:
  //   dist/backend/   (this file's __dirname)
  // and the frontend static files live at:
  //   public/         (two levels up: dist/backend → dist → public)
  const pluginPublic = join(__dirname, '..', '..', 'public');
  if (existsSync(pluginPublic)) return pluginPublic;
  return join(__dirname, '..', '..', 'frontend', 'dist');
}

const frontendPath = resolveFrontendPath();
const serveStaticImports = existsSync(frontendPath)
  ? [
      ServeStaticModule.forRoot({
        rootPath: frontendPath,
        exclude: ['/api/{*path}', '/otlp/{*path}', '/v1/{*path}'],
      }),
    ]
  : [];

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [appConfig] }),
    CacheModule.register({ isGlobal: true, ttl: DASHBOARD_CACHE_TTL_MS }),
    ...serveStaticImports,
    ThrottlerModule.forRoot([
      {
        ttl: Number(process.env['THROTTLE_TTL'] ?? 60000),
        limit: Number(process.env['THROTTLE_LIMIT'] ?? 100),
      },
    ]),
    CommonModule,
    DatabaseModule,
    TypeOrmModule.forFeature([ApiKey]),
    AuthModule,
    HealthModule,
    TelemetryModule,
    AnalyticsModule,
    SecurityModule,
    OtlpModule,
    ModelPricesModule,
    NotificationsModule,
    RoutingModule,
    SseModule,
    GithubModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: sessionGuardClass },
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
