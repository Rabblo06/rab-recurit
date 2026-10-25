import { useId, useState } from 'react';

import { AcsIcon } from './icons';

/**
 * The design's `keyBox()`: the manual setup key from the server (8 groups of 4 — it wraps to a second line inside the box,
 * UI_PLAN §7 #8). Copy strips the spaces. The key is only ever in this component's props; nothing stores it.
 */
export default function SetupKeyBox({ manualKey }: { manualKey: string }) {
  const labelId = useId();
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(manualKey.replace(/\s+/g, ''));
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  }

  return (
    <div className="acs-field">
      <span id={labelId}>Setup key</span>
      <div className="acs-key-box" role="group" aria-labelledby={labelId}>
        <span className="acs-key-value">{manualKey}</span>
        <button
          type="button"
          className="acs-link acs-icon-only"
          aria-label="Copy setup key"
          onClick={() => void copy()}
        >
          <AcsIcon
            name={copied === 'copied' ? 'check' : 'copy'}
            className="acs-icon--sm"
          />
        </button>
      </div>
      <span className="acs-visually-hidden" role="status">
        {copied === 'copied'
          ? 'Setup key copied.'
          : copied === 'failed'
            ? 'Couldn’t copy. Select the key and copy it instead.'
            : ''}
      </span>
    </div>
  );
}
