import { IconCheck } from '@tabler/icons-react';
import { s } from './authStyles';

export default function AuthSuccess({ setup = false, loginHref }: { setup?: boolean; loginHref?: string }) {
  return <section role="status" aria-live="polite" style={{ textAlign: 'center', padding: '12px 0' }}>
    <IconCheck size={36} color="#0f5c3f" aria-hidden style={{ marginBottom: 20 }} />
    <h1 style={s.title}>{setup ? 'Your account setup is complete' : 'Password updated successfully'}</h1>
    <p style={{ ...s.subtitle, marginBottom: 0 }}>
      {loginHref ? <a href={loginHref} style={{ color: '#0f5c3f', textDecoration: 'underline' }}>Go back to login</a> : 'Go back to login'}
    </p>
  </section>;
}
