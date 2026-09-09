import { Global, Module } from '@nestjs/common';

import { EmailDriverFactory } from './email-driver.factory';
import { EmailOutboxService } from './email-outbox.service';
import { EmailQueueService } from './email-queue.service';
import { EmailService } from './email.service';

@Global()
@Module({
  providers: [EmailDriverFactory, EmailService, EmailOutboxService, EmailQueueService],
  exports: [EmailService, EmailOutboxService, EmailQueueService],
})
export class EmailModule {}
