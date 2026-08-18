import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * argon2id, `m=19456, t=2, p=1` minimum — memory-hard, resistant to GPU/ASIC
 * cracking (rab-workforce-architecture.md §5.1, CLAUDE.md). Never bcrypt,
 * MD5, SHA, or custom crypto.
 */
@Injectable()
export class PasswordHashingService {
  private readonly options: argon2.Options = {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  };

  hash(password: string): Promise<string> {
    return argon2.hash(password, this.options);
  }

  verify(hash: string, password: string): Promise<boolean> {
    return argon2.verify(hash, password);
  }
}
