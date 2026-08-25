import { Controller, Get, NotFoundException, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';

import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StorageService } from './storage.service';

/**
 * Serves uploaded avatar/logo bytes. Tenant-scoped by construction — every
 * key this app ever writes is prefixed `org/{organisationId}/...`
 * (StorageService), so requiring the requested key to start with the
 * caller's own `org/{ctx.organisationId}/` prefix is a real authorization
 * check, not decoration: a key belonging to a different organisation 404s
 * (never 403 — its existence isn't confirmed either) rather than being
 * served.
 */
@Controller('rest/v1/files')
@UseGuards(JwtAuthGuard)
export class FilesController {
  constructor(private readonly storageService: StorageService) {}

  @Get('*')
  async serve(@Req() request: AuthenticatedRequest, @Res() response: Response): Promise<void> {
    const key = request.path.replace(/^\/rest\/v1\/files\//, '');
    const allowedPrefix = `org/${request.authContext.organisationId}/`;
    if (!key.startsWith(allowedPrefix)) {
      throw new NotFoundException('File not found.');
    }

    const file = await this.storageService.read(key);
    if (!file) {
      throw new NotFoundException('File not found.');
    }

    response.setHeader('Content-Type', file.mimetype);
    response.setHeader('Cache-Control', 'private, max-age=3600');
    response.send(file.buffer);
  }
}
