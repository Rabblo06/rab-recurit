import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { UpdateNotificationPreferenceDto } from '../dto/update-notification-preference.dto';
import { UpdateProfileDto } from '../dto/update-profile.dto';
import { UpdateUserPreferenceDto } from '../dto/update-user-preference.dto';
import { ProfileService } from '../services/profile.service';

const AVATAR_UPLOAD_OPTIONS = {
  storage: memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // fast-fail before the buffer is fully read; StorageService re-checks server-side
};

/**
 * Every route here operates on the caller's own account only — no
 * PermissionFlag gate, because there's nothing to grant/revoke: a user
 * always has access to their own profile/preferences/sessions.
 */
@Controller('rest/v1/profile')
@UseGuards(JwtAuthGuard)
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Get()
  getProfile(@AuthUser() ctx: AuthContext) {
    return this.profileService.getProfile(ctx);
  }

  @Patch()
  updateProfile(@AuthUser() ctx: AuthContext, @Body() dto: UpdateProfileDto) {
    return this.profileService.updateProfile(ctx, dto);
  }

  @Post('avatar')
  @UseInterceptors(FileInterceptor('file', AVATAR_UPLOAD_OPTIONS))
  uploadAvatar(@AuthUser() ctx: AuthContext, @UploadedFile() file?: { buffer: Buffer }) {
    if (!file) throw new BadRequestException('No file was uploaded.');
    return this.profileService.uploadAvatar(ctx, file.buffer);
  }

  @Delete('avatar')
  deleteAvatar(@AuthUser() ctx: AuthContext) {
    return this.profileService.deleteAvatar(ctx);
  }

  @Get('preferences')
  getPreferences(@AuthUser() ctx: AuthContext) {
    return this.profileService.getPreferences(ctx);
  }

  @Patch('preferences')
  updatePreferences(@AuthUser() ctx: AuthContext, @Body() dto: UpdateUserPreferenceDto) {
    return this.profileService.updatePreferences(ctx, dto);
  }

  @Get('sessions')
  listSessions(@AuthUser() ctx: AuthContext) {
    return this.profileService.listSessions(ctx);
  }

  @Delete('sessions/:familyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeSession(@AuthUser() ctx: AuthContext, @Param('familyId') familyId: string) {
    return this.profileService.revokeSession(ctx, familyId);
  }

  @Get('notification-preferences')
  listNotificationPreferences(@AuthUser() ctx: AuthContext) {
    return this.profileService.listNotificationPreferences(ctx);
  }

  @Patch('notification-preferences')
  updateNotificationPreference(@AuthUser() ctx: AuthContext, @Body() dto: UpdateNotificationPreferenceDto) {
    return this.profileService.updateNotificationPreference(ctx, dto);
  }
}
