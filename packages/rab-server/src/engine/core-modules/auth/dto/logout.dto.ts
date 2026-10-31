import { IsOptional, IsUUID } from 'class-validator';

import { RefreshDto } from './refresh.dto';

/**
 * `POST /auth/logout` body (Phase C1b, D5). Everything `RefreshDto` accepted is still accepted (installed apps keep
 * working unchanged); a mobile client may additionally name ITS OWN push installation — the same `deviceId` it
 * registered with `POST /push/devices` — so logout deactivates exactly that device, for exactly the caller, in the
 * logout transaction. It is never an identity: the device is looked up under `ctx.userId` only, so naming another
 * user's device id deactivates nothing. A malformed value is a 400 (validated before anything is revoked).
 */
export class LogoutDto extends RefreshDto {
  @IsOptional()
  @IsUUID()
  pushDeviceId?: string;
}
