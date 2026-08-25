import { Global, Module } from '@nestjs/common';

import { EmailDriverFactory } from './email-driver.factory';
import { EmailService } from './email.service';

@Global()
@Module({
  providers: [EmailDriverFactory, EmailService],
  exports: [EmailService],
})
export class EmailModule {}
