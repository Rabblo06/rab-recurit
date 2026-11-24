import { Blobatar } from '@blobatar/react';
import { createContext, ReactNode, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../api';
import { getGeneration, getSessionId, getSessionStatus, subscribeToSession } from '../lib/auth-session';
import './avatar.css';

/** Workspace boundary supplied by the shell; no image bytes are persisted. */
export const ImageWorkspaceContext = createContext('default');
const identityKey = () => `${getGeneration()}:${getSessionId() ?? ''}:${getSessionStatus()}`;

type AvatarProps = {
  imageKey?: string | null;
  previewUrl?: string | null;
  label: string;
  alt?: string;
  variant?: 'large' | 'sidebar' | 'panel' | 'xl';
  fallback?: ReactNode;
  loading?: 'eager' | 'lazy';
};

/** Images keep the authenticated API transport and its existing private browser cache. */
export default function Avatar(props: AvatarProps) {
  const identity = useSyncExternalStore(subscribeToSession, identityKey);
  const workspace = useContext(ImageWorkspaceContext);
  const scope = identity + ':' + workspace;
  const previewOwner = useRef({ url: props.previewUrl, scope });
  if (previewOwner.current.url !== props.previewUrl) previewOwner.current = { url: props.previewUrl, scope };
  const previewUrl = previewOwner.current.scope === scope && getSessionStatus() !== 'unauthenticated' ? props.previewUrl : null;
  const imageKey = getSessionStatus() === 'unauthenticated' ? null : props.imageKey;
  return <AvatarContent key={`${scope}:${previewUrl ?? imageKey ?? 'empty'}`} {...props} imageKey={imageKey} previewUrl={previewUrl} />;
}
function AvatarContent({ imageKey, previewUrl, label, alt, variant = 'large', fallback, loading = 'lazy' }: AvatarProps) {
  const root = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const started = useRef(0);
  const [visible, setVisible] = useState(loading === 'eager' || typeof IntersectionObserver === 'undefined');
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [instant, setInstant] = useState(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (visible || !root.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '160px' });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    started.current = performance.now();
    if (previewUrl || !imageKey || getSessionStatus() === 'unauthenticated') return;
    let cancelled = false;
    let objectUrl: string | null = null;
    const controller = new AbortController();
    api.get(`/files/${imageKey}`, { responseType: 'blob', signal: controller.signal }).then(res => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(res.data);
      setBlobUrl(objectUrl);
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [imageKey, previewUrl, visible]);
  const reveal = async (image: HTMLImageElement) => {
    try {
      if (image.decode) await image.decode();
      if (!alive.current) return;
      // Cached/local images must not spend an artificial interval in a loading animation.
      setInstant(performance.now() - started.current < 80);
      setLoaded(true);
    } catch { if (alive.current) setFailed(true); }
  };
  const src = visible ? previewUrl ?? blobUrl : null;
  const className = variant === 'sidebar' ? 'workspace-icon' : variant === 'panel' ? 'avatar-panel' : variant === 'xl' ? 'avatar-xl' : 'avatar-upload-preview';
  const hasPhoto = !!(previewUrl || imageKey) && !failed;
  return <div ref={root} className={`${className} progressive-avatar${loaded ? ' is-loaded' : ''}${instant ? ' is-instant' : ''}`} aria-busy={hasPhoto && !loaded}>
    <span className="avatar-image-placeholder" aria-hidden="true">{!hasPhoto ? fallback ?? <Blobatar name={label.trim() || 'Crewflow'} size={variant === 'xl' ? 96 : 48} style={{ width: '100%', height: '100%' }} /> : null}</span>
    {hasPhoto && !loaded && <span className="sr-only" role="img" aria-label={`Loading ${alt ?? label}`} />}
    {hasPhoto && src && <img src={src} alt={alt ?? label} decoding="async" onLoad={event => { void reveal(event.currentTarget); }} onError={() => setFailed(true)} />}
  </div>;
}
