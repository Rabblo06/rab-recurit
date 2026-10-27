import { useId, useState } from 'react';

import { downloadRecoveryCodes } from '../mfaApi';
import { AcsIcon } from './icons';

/**
 * The design's codes step (`codeList()` + Copy / Download .txt + the acknowledgement). The codes come straight from the
 * server response that created them and are shown ONCE: they live in the parent's state only until its dialog or step
 * is left (the server keeps one-way hashes). Copy writes plain text to the clipboard; Download builds a local .txt Blob.
 * Neither ever stores, logs or uploads them. The parent's Done/Continue is gated on `acknowledged`.
 */
export default function RecoveryCodesPanel({
  codes,
  accountLabel,
  acknowledged,
  onAcknowledgedChange,
}: {
  codes: readonly string[];
  accountLabel?: string;
  acknowledged: boolean;
  onAcknowledgedChange: (value: boolean) => void;
}) {
  const checkId = useId();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  return (
    <>
      <ol className="acs-code-list" aria-label="Recovery codes">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <div className="acs-row acs-row--wrap">
        <button
          type="button"
          className="acs-btn acs-btn--secondary"
          onClick={() => void copy()}
        >
          <AcsIcon name={copyState === 'copied' ? 'check' : 'copy'} />{' '}
          {copyState === 'copied' ? 'Copied' : 'Copy codes'}
        </button>
        <button
          type="button"
          className="acs-btn acs-btn--secondary"
          onClick={() => downloadRecoveryCodes(codes, accountLabel)}
        >
          <AcsIcon name="download" /> Download .txt
        </button>
      </div>
      <span className="acs-visually-hidden" role="status">
        {copyState === 'copied'
          ? 'Recovery codes copied.'
          : copyState === 'failed'
            ? 'Couldn’t copy. Select the codes and copy them, or download the file.'
            : ''}
      </span>
      {copyState === 'failed' && (
        <p className="acs-helper-text">
          Couldn’t copy. Select the codes and copy them, or download the file.
        </p>
      )}
      <label className="acs-check" htmlFor={checkId}>
        <input
          id={checkId}
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => onAcknowledgedChange(e.target.checked)}
        />
        I’ve saved my recovery codes somewhere safe.
      </label>
    </>
  );
}
