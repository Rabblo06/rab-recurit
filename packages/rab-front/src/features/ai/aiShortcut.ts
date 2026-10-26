/**
 * U2 (owner decision 5): the Ask AI panel toggles with ⌘J on macOS and Ctrl+J everywhere else. Only the platform's own
 * modifier counts (Ctrl+J on a Mac and ⌘J elsewhere do nothing), so the browser's other shortcuts are left alone.
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function isAskAiShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, apple = isApplePlatform()): boolean {
  if (event.altKey || event.shiftKey || event.key.toLowerCase() !== 'j') return false;
  return apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function askAiShortcutLabel(apple = isApplePlatform()): string {
  return apple ? '⌘J' : 'Ctrl+J';
}
