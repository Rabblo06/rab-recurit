import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EnvironmentVariables } from './environment-variables';

/**
 * Typed accessor over validated env vars. Nothing outside this module
 * should call `process.env` or the raw `ConfigService` directly.
 */
@Injectable()
export class EnvironmentService {
  constructor(private readonly configService: ConfigService<EnvironmentVariables, true>) {}

  get<T extends keyof EnvironmentVariables>(key: T): EnvironmentVariables[T] {
    return this.configService.get(key, { infer: true });
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }

  get corsOrigins(): string[] {
    return this.get('CORS_ORIGINS')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  }
}
