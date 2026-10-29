import type { NetworkInterfaceInfo } from 'node:os';

const ipv4: NetworkInterfaceInfo = {
  address: '10.0.0.5',
  netmask: '255.0.0.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:01',
  internal: false,
  cidr: '10.0.0.5/8',
};
const ipv6: NetworkInterfaceInfo = {
  address: 'fd00::5',
  netmask: 'ffff::',
  family: 'IPv6',
  mac: '00:00:00:00:00:01',
  internal: false,
  cidr: 'fd00::5/16',
  scopeid: 0,
};

jest.mock('node:os', () => ({
  ...jest.requireActual('node:os'),
  networkInterfaces: () => ({ eth0: [ipv4, ipv6] }),
}));

type Shared = {
  networkInterfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
  _readNetworkInterfaces?: () =>
    NodeJS.Dict<NetworkInterfaceInfo[]> | undefined;
};

describe('SmtpDriver IPv6 resolution patch', () => {
  // The real, installed nodemailer: the patch reaches into its internals, so a mock would prove nothing about the version
  // that ships. A fresh module registry per test, so nodemailer has not read the interface table yet (the state at
  // process start) and the driver's own lazy require gets the same instance as this spec.
  beforeEach(() => jest.resetModules());

  it('leaves no IPv6 address in the table nodemailer reads when it resolves an SMTP host, including on its first read', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const shared = require('nodemailer/lib/shared') as Shared;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SmtpDriver } =
      require('./smtp.driver') as typeof import('./smtp.driver');

    new SmtpDriver({ host: 'smtp.example.test', port: 587 });

    const seenBySend = shared._readNetworkInterfaces
      ? shared._readNetworkInterfaces()
      : shared.networkInterfaces;
    const families = Object.values(seenBySend ?? {})
      .flat()
      .map((a) => a?.family);
    expect(families).toEqual(['IPv4']);
  });
});
