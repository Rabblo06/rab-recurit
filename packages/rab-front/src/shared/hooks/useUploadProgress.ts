import { useCallback, useMemo, useState } from 'react';
import type { AxiosProgressEvent } from 'axios';
import { phaseFromProgress, uploadPhaseLabel, type UploadPhase } from '../lib/upload';

/**
 * Progress state for one upload control. Pass `onUploadProgress` to the axios call, `begin()` before it and `end()` in
 * `finally`. `label` is the text for the triggering button ("Uploading 42%…" → "Processing…"); `announcement` changes
 * only when the phase changes, for a polite live region (a percentage per tick would flood a screen reader).
 */
export function useUploadProgress(noun = 'file') {
  const [state, setState] = useState<{ phase: UploadPhase; percent: number | null }>({ phase: 'idle', percent: null });
  // No percentage until the transport reports real progress ("Uploading…", never a made-up "0%").
  const begin = useCallback(() => setState({ phase: 'uploading', percent: null }), []);
  const end = useCallback(() => setState({ phase: 'idle', percent: null }), []);
  const onUploadProgress = useCallback((event: AxiosProgressEvent) => setState(phaseFromProgress(event)), []);
  const announcement = state.phase === 'uploading' ? `Uploading ${noun}…` : state.phase === 'processing' ? `Upload complete. Saving your ${noun}…` : '';
  return useMemo(
    () => ({ ...state, active: state.phase !== 'idle', label: uploadPhaseLabel(state.phase, state.percent), announcement, begin, end, onUploadProgress }),
    [state, announcement, begin, end, onUploadProgress],
  );
}
