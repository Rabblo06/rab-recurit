import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { SearchController } from './controllers/search.controller';
import { SearchService } from './services/search.service';

@Module({
  imports: [AuthModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
