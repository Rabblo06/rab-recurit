import { EnvironmentService } from '../environment/environment.service';
import { LoggerDriver } from './drivers/logger.driver';
import { ResendDriver } from './drivers/resend.driver';
import { SmtpDriver } from './drivers/smtp.driver';
import { EmailDriverFactory } from './email-driver.factory';

function buildFactory(vars: Record<string, unknown>): EmailDriverFactory {
  const env = { get: jest.fn((key: string) => vars[key]) } as unknown as EnvironmentService;
  return new EmailDriverFactory(env);
}

describe('EmailDriverFactory', () => {
  it('returns a LoggerDriver for EMAIL_DRIVER=LOGGER', () => {
    const factory = buildFactory({ EMAIL_DRIVER: 'LOGGER' });
    expect(factory.getDriver()).toBeInstanceOf(LoggerDriver);
  });

  it('returns an SmtpDriver for EMAIL_DRIVER=SMTP when EMAIL_SMTP_HOST is set', () => {
    const factory = buildFactory({
      EMAIL_DRIVER: 'SMTP',
      EMAIL_SMTP_HOST: 'smtp.example.test',
      EMAIL_SMTP_PORT: 587,
      EMAIL_SMTP_NO_TLS: false,
    });
    expect(factory.getDriver()).toBeInstanceOf(SmtpDriver);
  });

  it('refuses SMTP without EMAIL_SMTP_HOST', () => {
    const factory = buildFactory({ EMAIL_DRIVER: 'SMTP' });
    expect(() => factory.getDriver()).toThrow(/EMAIL_SMTP_HOST/);
  });

  it('returns a ResendDriver for EMAIL_DRIVER=RESEND when RESEND_API_KEY is set', () => {
    const factory = buildFactory({ EMAIL_DRIVER: 'RESEND', RESEND_API_KEY: 're_test_key' });
    expect(factory.getDriver()).toBeInstanceOf(ResendDriver);
  });

  it('refuses RESEND without RESEND_API_KEY', () => {
    const factory = buildFactory({ EMAIL_DRIVER: 'RESEND' });
    expect(() => factory.getDriver()).toThrow(/RESEND_API_KEY/);
  });

  it('rejects an unrecognised EMAIL_DRIVER value', () => {
    const factory = buildFactory({ EMAIL_DRIVER: 'MAILGUN' });
    expect(() => factory.getDriver()).toThrow(/LOGGER, SMTP, or RESEND/);
  });
});
