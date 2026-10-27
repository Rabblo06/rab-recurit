import { askAiShortcutLabel, isAskAiShortcut } from './aiShortcut';

/** U2 owner decision 5: ⌘J on macOS, Ctrl+J elsewhere — and only that combination. */
const key = (over: Partial<KeyboardEvent>) => ({ key: 'j', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over }) as KeyboardEvent;

it('macOS: ⌘J only', () => {
  expect(isAskAiShortcut(key({ metaKey: true }), true)).toBe(true);
  expect(isAskAiShortcut(key({ ctrlKey: true }), true)).toBe(false);
  expect(isAskAiShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
  expect(askAiShortcutLabel(true)).toBe('⌘J');
});

it('elsewhere: Ctrl+J only (upper-case J with Caps Lock counts)', () => {
  expect(isAskAiShortcut(key({ ctrlKey: true }), false)).toBe(true);
  expect(isAskAiShortcut(key({ ctrlKey: true, key: 'J' }), false)).toBe(true);
  expect(isAskAiShortcut(key({ metaKey: true }), false)).toBe(false);
  expect(isAskAiShortcut(key({ ctrlKey: true, altKey: true }), false)).toBe(false);
  expect(isAskAiShortcut(key({ ctrlKey: true, key: 'k' }), false)).toBe(false);
  expect(askAiShortcutLabel(false)).toBe('Ctrl+J');
});
