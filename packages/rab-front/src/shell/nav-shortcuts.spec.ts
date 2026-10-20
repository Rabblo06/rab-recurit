import { isDuplicate, parseShortcuts, storageKey, validateLink, type Shortcut } from './nav-shortcuts';
import { supportChannels } from '../features/help/support-channels';
import { searchTopics } from '../features/help/help-topics';

describe('validateLink', () => {
  it.each([
    'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'http://example.com',
    '//evil.example', '/\\evil', 'https://user:pass@example.com', 'https://localhost', '/not-a-page', 'https://ex ample.com', ' ',
  ])('rejects %s', (raw) => {
    expect(validateLink(raw).ok).toBe(false);
  });

  it('accepts internal Crewflow paths and https sites (normalised)', () => {
    expect(validateLink('/shifts?status=completed')).toEqual({ ok: true, kind: 'internal', to: '/shifts?status=completed' });
    expect(validateLink(' https://docs.example.com/guide ')).toEqual({ ok: true, kind: 'external', href: 'https://docs.example.com/guide' });
  });
});

describe('shortcut storage', () => {
  it('is namespaced by user AND workspace, and never written without an identity', () => {
    expect(storageKey('u1', 'w1')).not.toBe(storageKey('u2', 'w1'));
    expect(storageKey('u1', 'w1')).not.toBe(storageKey('u1', 'w2'));
    expect(storageKey(null, 'w1')).toBeNull();
  });

  it('drops malformed, unknown and unsafe entries and re-homes items whose folder is gone', () => {
    const raw = JSON.stringify([
      { id: 'a', kind: 'object', label: 'Shifts', icon: 'shift', target: 'shifts' },
      { id: 'b', kind: 'object', label: 'Invented', icon: 'object', target: 'crm-deals' },
      { id: 'c', kind: 'view', label: 'Free query', icon: 'view', target: '/shifts?sql=drop' },
      { id: 'd', kind: 'link', label: 'Bad', icon: 'link', target: 'javascript:alert(1)' },
      { id: 'e', kind: 'record', label: 'Staff', icon: 'person', target: 'Staff:abc-123', parentId: 'gone' },
      { id: 'f', kind: 'nonsense', label: 'x' },
      'not an object',
    ]);
    const parsed = parseShortcuts(raw);
    expect(parsed.map((s) => s.id)).toEqual(['a', 'e']);
    expect(parsed.find((s) => s.id === 'e')?.parentId).toBeNull();
    expect(parseShortcuts('{not json')).toEqual([]);
  });

  it('refuses a second shortcut to the same destination, and duplicate folder names', () => {
    const list: Shortcut[] = [
      { id: 'a', kind: 'object', label: 'Shifts', icon: 'shift', target: 'shifts' },
      { id: 'f', kind: 'folder', label: 'Weekend', icon: 'folder' },
    ];
    expect(isDuplicate(list, { kind: 'object', target: 'shifts', label: 'My shifts' })).toBe(true);
    expect(isDuplicate(list, { kind: 'object', target: 'offers', label: 'Offers' })).toBe(false);
    expect(isDuplicate(list, { kind: 'folder', label: ' weekend ' })).toBe(true);
  });
});

describe('Support channel configuration', () => {
  it('uses only a valid configured email / https URL; otherwise reports none', () => {
    expect(supportChannels({})).toEqual({ email: null, url: null });
    expect(supportChannels({ VITE_SUPPORT_EMAIL: 'not-an-email', VITE_SUPPORT_URL: 'http://plain.example' })).toEqual({ email: null, url: null });
    expect(supportChannels({ VITE_SUPPORT_EMAIL: 'help@example.com', VITE_SUPPORT_URL: 'https://support.example.com' }))
      .toEqual({ email: 'help@example.com', url: 'https://support.example.com/' });
  });
});

describe('Help Center search', () => {
  it('finds topics by words in their steps', () => {
    expect(searchTopics('timesheet').map((t) => t.id)).toContain('timesheets');
    expect(searchTopics('zzz-no-such-topic')).toEqual([]);
  });
});
