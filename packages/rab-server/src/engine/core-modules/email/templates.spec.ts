import {
  renderAccountInviteEmail,
  renderAccountSuspendedEmail,
  renderPasswordResetEmail,
  renderPasswordUpdatedEmail,
  renderWelcomeEmail,
} from './templates';

/**
 * Rendering regression coverage for the production email path
 * (`react-dom/server`'s `renderToStaticMarkup` + `@react-email/render`'s
 * `toPlainText`) — deliberately independent of the `react-email` CLI
 * devDependency in `rab-emails` (see that package's own `project.json`
 * `start` target), which this suite never touches. Fixture data below is
 * synthetic — no real names, emails, or URLs.
 */
describe('production email rendering', () => {
  it('renders the account invite email with subject, HTML, and plain text', () => {
    const result = renderAccountInviteEmail({
      firstName: 'Test',
      organisationName: 'Acme Staffing',
      setupUrl: 'https://example.test/setup/abc123',
    });
    expect(result.subject).toBe('Your account has been created');
    expect(result.html).toContain('Test');
    expect(result.html).toContain('Acme Staffing');
    expect(result.html).toContain('https://example.test/setup/abc123');
    expect(result.html).toMatch(/^<!DOCTYPE html/);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).toContain('Set your password');
  });

  it('renders the password reset email for both self-requested and admin-triggered variants', () => {
    const self = renderPasswordResetEmail({
      firstName: 'Test',
      resetUrl: 'https://example.test/reset/xyz789',
      selfRequested: true,
    });
    expect(self.subject).toBe('Reset your rab password');
    expect(self.html).toContain('https://example.test/reset/xyz789');
    expect(self.text.length).toBeGreaterThan(0);

    const admin = renderPasswordResetEmail({
      firstName: 'Test',
      resetUrl: 'https://example.test/reset/xyz789',
      selfRequested: false,
    });
    expect(admin.html).toContain('https://example.test/reset/xyz789');
  });

  it('renders the welcome email', () => {
    const result = renderWelcomeEmail({ firstName: 'Test', organisationName: 'Acme Staffing' });
    expect(result.subject).toBe('Welcome to Acme Staffing');
    expect(result.html).toContain('Welcome, Test');
    expect(result.html).toContain('Acme Staffing');
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('renders the password updated email', () => {
    const result = renderPasswordUpdatedEmail({ firstName: 'Test' });
    expect(result.subject).toBe('Your rab password was changed');
    expect(result.html).toContain('Test');
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('renders the account suspended email', () => {
    const result = renderAccountSuspendedEmail({ firstName: 'Test', organisationName: 'Acme Staffing' });
    expect(result.subject).toBe('Your account access has been suspended');
    expect(result.html).toContain('Test');
    expect(result.html).toContain('Acme Staffing');
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('never throws a runtime import/render error for any template', () => {
    expect(() =>
      renderAccountInviteEmail({ firstName: 'A', organisationName: 'B', setupUrl: 'https://example.test' }),
    ).not.toThrow();
    expect(() =>
      renderPasswordResetEmail({ firstName: 'A', resetUrl: 'https://example.test', selfRequested: true }),
    ).not.toThrow();
    expect(() => renderWelcomeEmail({ firstName: 'A', organisationName: 'B' })).not.toThrow();
    expect(() => renderPasswordUpdatedEmail({ firstName: 'A' })).not.toThrow();
    expect(() => renderAccountSuspendedEmail({ firstName: 'A', organisationName: 'B' })).not.toThrow();
  });
});
