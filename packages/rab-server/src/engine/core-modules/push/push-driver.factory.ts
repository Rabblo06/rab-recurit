import { Injectable } from '@nestjs/common';

import { EnvironmentService } from '../environment/environment.service';
import { PushDriverInterface } from './drivers/interfaces/push-driver.interface';
import { FakeFcmDriver } from './drivers/fake-fcm.driver';
import { FcmDriver } from './drivers/fcm.driver';
import { ApnsDriver } from './drivers/apns.driver';

/**
 * Resolved fresh per send() call — same reasoning as `EmailDriverFactory`: a cheap switch, env
 * already validated once at boot. Routes by the TARGET DEVICE'S platform, not a single global
 * provider choice: android always goes to FCM, ios always goes to direct APNs (never through
 * Firebase) once PUSH_PROVIDER=REAL. In FAKE mode, platform is irrelevant — one universal fake
 * stands in for whichever real driver would have been chosen, since dispatch/retry/claim
 * correctness tests only need the `PushDriverInterface` CONTRACT, never FCM- or APNs-specific wire
 * behaviour.
 */
@Injectable()
export class PushDriverFactory {
  constructor(private readonly env: EnvironmentService) {}

  getDriver(platform: 'ios' | 'android'): PushDriverInterface {
    const provider = this.env.get('PUSH_PROVIDER');

    if (provider === 'FAKE') return new FakeFcmDriver();
    if (provider === 'REAL') {
      return platform === 'android'
        ? new FcmDriver(this.env.get('FIREBASE_SERVICE_ACCOUNT_JSON'))
        : new ApnsDriver({
            authKeyP8: this.env.get('APNS_AUTH_KEY_P8'),
            keyId: this.env.get('APNS_KEY_ID'),
            teamId: this.env.get('APNS_TEAM_ID'),
            bundleId: this.env.get('APNS_BUNDLE_ID'),
            environment: this.env.get('APNS_ENVIRONMENT') as 'sandbox' | 'production',
          });
    }
    throw new Error(`Invalid PUSH_PROVIDER: "${provider}". Expected FAKE or REAL.`);
  }
}
