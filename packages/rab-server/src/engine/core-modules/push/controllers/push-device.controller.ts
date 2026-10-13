import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../decorators/auth-user.decorator';
import { AuthContext } from '../../tenant/auth-context.interface';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PushDeviceService } from '../push-device.service';
import { RegisterPushDeviceDto } from '../dto/register-push-device.dto';

/** Every authenticated identity registers its own devices — no permission flag beyond auth, same shape as `/notifications`. */
@Controller('rest/v1/push/devices')
@UseGuards(JwtAuthGuard)
export class PushDeviceController {
  constructor(private readonly pushDeviceService: PushDeviceService) {}

  @Post()
  register(@AuthUser() ctx: AuthContext, @Body() dto: RegisterPushDeviceDto) {
    return this.pushDeviceService.register(ctx, dto);
  }

  @Post(':deviceId/deactivate')
  @HttpCode(HttpStatus.NO_CONTENT)
  deactivate(@AuthUser() ctx: AuthContext, @Param('deviceId') deviceId: string) {
    return this.pushDeviceService.deactivate(ctx, deviceId, 'user_logout');
  }

  @Post('deactivate-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  deactivateAll(@AuthUser() ctx: AuthContext) {
    return this.pushDeviceService.deactivateAll(ctx, 'user_logout_all');
  }
}
