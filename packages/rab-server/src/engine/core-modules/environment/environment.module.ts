import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validate } from './env.validation';
import { EnvironmentService } from './environment.service';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
    }),
  ],
  providers: [EnvironmentService],
  exports: [EnvironmentService],
})
export class EnvironmentModule {}
