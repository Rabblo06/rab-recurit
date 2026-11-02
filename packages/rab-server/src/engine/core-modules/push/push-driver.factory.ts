import { Injectable, OnApplicationShutdown } from '@nestjs/common';

import { EnvironmentService } from '../environment/environment.service';
import { PushDriverInterface } from './drivers/interfaces/push-driver.interface';
import { FakeFcmDriver } from './drivers/fake-fcm.driver';
import { FcmDriver } from './drivers/fcm.driver';
import { ApnsDriver } from './drivers/apns.driver';

/**
 * Routes by the TARGET DEVICE'S platform, not a single global provider choice: android always goes to FCM, ios always
 * goes to direct APNs (never through Firebase) once PUSH_PROVIDER=REAL. In FAKE mode, platform is irrelevant — one
 * universal fake stands in for whichever real driver would have been chosen, since dispatch/retry/claim correctness tests
 * only need the `PushDriverInterface` CONTRACT, never FCM- or APNs-specific wire behaviour.
 *
 * D5: the REAL drivers are built ONCE per factory (a Nest singleton → once per process; env is validated at boot and
 * never changes), so APNs reuses its one HTTP/2 session and its cached provider JWT across sends, instead of a new TLS
 * session and a fresh JWT per push (D0-C §4.2/4.3). FCM's Firebase app is per process anyway (fcm.driver.ts). The fake
 * stays per call (its state is static).
 */
@Injectable()
export class PushDriverFactory implements OnApplicationShutdown {
  private fcm: FcmDriver | null = null;
  private apns: ApnsDriver | null = null;

  constructor(private readonly env: EnvironmentService) {}

  getDriver(platform: 'ios' | 'android'): PushDriverInterface {
    const provider = this.env.get('PUSH_PROVIDER');

    if (provider === 'FAKE') return new FakeFcmDriver();
    if (provider === 'REAL') {
      if (platform === 'android') {
        this.fcm ??= new FcmDriver(this.env.get('FIREBASE_SERVICE_ACCOUNT_JSON'));
        return this.fcm;
      }
      this.apns ??= new ApnsDriver({
        authKeyP8: this.env.get('APNS_AUTH_KEY_P8'),
        keyId: this.env.get('APNS_KEY_ID'),
        teamId: this.env.get('APNS_TEAM_ID'),
        bundleId: this.env.get('APNS_BUNDLE_ID'),
        environment: this.env.get('APNS_ENVIRONMENT') as 'sandbox' | 'production',
      });
      return this.apns;
    }
    throw new Error(`Invalid PUSH_PROVIDER: "${provider}". Expected FAKE or REAL.`);
  }

  /** Closes the APNs session on shutdown (it is unref'd, so it never holds the process open either way). */
  onApplicationShutdown(): void {
    this.apns?.close();
  }
}
