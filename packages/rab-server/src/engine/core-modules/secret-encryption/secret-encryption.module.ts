import { Global, Module } from '@nestjs/common';

import { SecretEncryptionService } from './secret-encryption.service';
import { SecretRotationService } from './secret-rotation.service';

@Global()
@Module({
  providers: [SecretEncryptionService, SecretRotationService],
  exports: [SecretEncryptionService, SecretRotationService],
})
export class SecretEncryptionModule {}
