import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { SearchDto } from '../dto/search.dto';
import { SearchService } from '../services/search.service';

@Controller('rest/v1/search')
@UseGuards(JwtAuthGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  search(@AuthUser() ctx: AuthContext, @Query() dto: SearchDto) {
    return this.searchService.search(ctx, dto);
  }
}
