'use client';

/**
 * CoverPicker — modal for choosing a custom cover image for a Reel.
 *
 * Two ways to pick:
 *
 *   1. **Upload image** — file input → upload via the existing uploads
 *      service → returns an upload id. Same flow as the main composer
 *      attaches an image.
 *
 *   2. **Pick frame** — render the attached video, let the user scrub
 *      to a frame, capture that frame to a canvas, convert to a Blob,
 *      then upload the blob the same way. No server-side video decode
 *      needed; the browser already has the bytes.
 *
 * On confirm, calls onPick(uploadId, previewUrl). The previewUrl is
 * what we show as the small thumbnail in the composer — saves the
 * composer from having to re-fetch.
 *
 * No frame capture for cross-origin videos. Our videos are served by
 * our own API so canvas tainting isn't an issue.
 */

import { useEffect, useRef, useState } from 'react';
import { X, Upload as UploadIcon, Image as ImageIcon, Film, RefreshCw } from 'lucide-react';
import { uploads, ApiError } from '@/lib/api';

interface Props {
  /** The attached video's uploadId. We render this for the frame picker. */
  videoUploadId: string;
  /** Pre-selected cover upload id (if any) — modal opens with this
   *  pre-loaded so editing an existing cover is non-destructive. */
  initialCoverUploadId: string | null;
  onClose: () => void;
  onPick: (uploadId: string | null) => void;
}

type Tab = 'upload' | 'frame';

export function CoverPicker({ videoUploadId, initialCoverUploadId, onClose, onPick }: Props) {
  const [tab, setTab] = useState<Tab>('frame');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track the latest upload picked in this modal — confirm copies it
  // to onPick. Local state lets the user switch tabs without losing
  // their previous selection.
  const [pickedUploadId, setPickedUploadId] = useState<string | null>(initialCoverUploadId);

  // ─── Upload tab ───
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const r = await uploads.upload(file);
      // Defensive: log and surface a clear error when the backend
      // returns a shape we didn't expect. Previously we blindly read
      // r.upload.id and a missing .upload would throw with a generic
      // 'Upload failed' message, which masked the actual problem.
      // eslint-disable-next-line no-console
      console.debug('[CoverPicker] upload response:', r);
      if (!r || typeof r !== 'object' || !('upload' in r)) {
        throw new Error('Server returned an unexpected response (missing upload field). Check container logs.');
      }
      const uploadObj = (r as { upload: { id?: string } }).upload;
      if (!uploadObj || !uploadObj.id) {
        throw new Error('Server returned an upload without an id. Check container logs.');
      }
      setPickedUploadId(uploadObj.id);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[CoverPicker] upload failed:', e);
      setError(
        e instanceof ApiError
          ? `${e.message} (status ${e.status})`
          : e instanceof Error
            ? e.message
            : 'Upload failed'
      );
    } finally {
      setBusy(false);
    }
  }

  // ─── Frame picker tab ───
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [frameTimeMs, setFrameTimeMs] = useState(0);

  // Scrub the video to the current slider position whenever it
  // changes. We deliberately do NOT guard with an abs-diff check —
  // even tiny seeks need to happen so the browser repaints the
  // <video> element with the new frame. Without this, the visible
  // frame can lag behind the slider during drags.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    // Skip if metadata isn't loaded yet (duration NaN) — we'd be
    // seeking into an invalid range.
    if (!isFinite(v.duration)) return;
    const target = frameTimeMs / 1000;
    // Clamp to the readable range; seeking past duration produces
    // nothing useful and some browsers ignore it silently.
    v.currentTime = Math.min(target, Math.max(0, v.duration - 0.01));
  }, [frameTimeMs]);

  async function captureFrame() {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c) return;
    setBusy(true);
    setError(null);
    try {
      // Make sure we're at the requested frame before grabbing.
      if (Math.abs(v.currentTime - frameTimeMs / 1000) > 0.05) {
        v.currentTime = frameTimeMs / 1000;
        await new Promise<void>((resolve) => {
          const onSeeked = () => { v.removeEventListener('seeked', onSeeked); resolve(); };
          v.addEventListener('seeked', onSeeked);
        });
      }
      // Match canvas to native video dimensions so the captured image
      // is the highest resolution available, not the display size.
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('Could not get canvas context');
      ctx.drawImage(v, 0, 0, c.width, c.height);

      const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/jpeg', 0.92));
      if (!blob) throw new Error('Frame capture failed');

      // Wrap as a File so the uploads service treats it the same as
      // a normal image upload (it relies on file.name for content-type
      // and extension parsing).
      const file = new File([blob], `cover-${Date.now()}.jpg`, { type: 'image/jpeg' });
      const r = await uploads.upload(file);
      // eslint-disable-next-line no-console
      console.debug('[CoverPicker] frame upload response:', r);
      if (!r || typeof r !== 'object' || !('upload' in r)) {
        throw new Error('Server returned an unexpected response (missing upload field).');
      }
      const uploadObj = (r as { upload: { id?: string } }).upload;
      if (!uploadObj || !uploadObj.id) {
        throw new Error('Server returned an upload without an id.');
      }
      setPickedUploadId(uploadObj.id);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[CoverPicker] frame capture failed:', e);
      setError(e instanceof Error ? e.message : 'Frame capture failed');
    } finally {
      setBusy(false);
    }
  }

  // Build the video src once on mount (no token caching changes needed —
  // we use the same authed file URL that the composer uses for previews).
  const videoSrc = uploads.fileUrl(videoUploadId);
  const previewUrl = pickedUploadId ? uploads.fileUrl(pickedUploadId) : null;

  return (
    <div
      className="fixed inset-0 bg-ink/30 backdrop-blur-sm z-[100] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-lift w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-line">
          <h2 className="text-base font-semibold text-ink">Choose cover</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-ink-subtle hover:text-ink hover:bg-surface-hover"
          >
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-line px-3">
          <button
            onClick={() => setTab('frame')}
            className={[
              'px-3 py-2.5 text-sm font-medium border-b-2 transition-colors',
              tab === 'frame'
                ? 'border-accent text-accent'
                : 'border-transparent text-ink-muted hover:text-ink',
            ].join(' ')}
          >
            <Film size={14} className="inline mr-1.5 -mt-0.5" /> Pick frame
          </button>
          <button
            onClick={() => setTab('upload')}
            className={[
              'px-3 py-2.5 text-sm font-medium border-b-2 transition-colors',
              tab === 'upload'
                ? 'border-accent text-accent'
                : 'border-transparent text-ink-muted hover:text-ink',
            ].join(' ')}
          >
            <UploadIcon size={14} className="inline mr-1.5 -mt-0.5" /> Upload image
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {tab === 'frame' && (
            <div className="space-y-3">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video
                ref={videoRef}
                src={videoSrc}
                className="w-full max-h-[280px] rounded-lg bg-black object-contain"
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget;
                  setVideoDuration(v.duration * 1000);
                  // Force the browser to actually paint a frame. Without
                  // this, the <video> element renders as a black box on
                  // first show until the user manually scrubs. Setting
                  // currentTime to a non-zero value triggers a seek and
                  // a paint; 0.01s is far enough from 0 that browsers
                  // honor the seek but visually still the "first frame".
                  if (isFinite(v.duration)) {
                    v.currentTime = Math.min(0.01, v.duration - 0.001);
                  }
                }}
                preload="metadata"
                muted
                playsInline
              />
              <canvas ref={canvasRef} className="hidden" />
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-ink-subtle">
                  <span>Scrub to choose a frame</span>
                  <span className="font-mono tabular-nums">
                    {(frameTimeMs / 1000).toFixed(1)}s
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, videoDuration)}
                  step={100}
                  value={frameTimeMs}
                  onChange={(e) => setFrameTimeMs(Number(e.target.value))}
                  className="w-full accent-accent"
                />
              </div>
              <button
                onClick={captureFrame}
                disabled={busy}
                className="btn-primary w-full"
              >
                {busy ? (
                  <span className="inline-flex items-center gap-2">
                    <RefreshCw size={14} className="animate-spin" /> Capturing…
                  </span>
                ) : (
                  'Use this frame'
                )}
              </button>
            </div>
          )}

          {tab === 'upload' && (
            <div className="space-y-3">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  // Reset the input value so the user can pick the SAME
                  // file again later (otherwise onChange won't fire on
                  // re-pick because the value hasn't "changed").
                  e.target.value = '';
                  if (f) handleFile(f);
                }}
                className="hidden"
                id="cover-file-input"
              />
              <label
                htmlFor="cover-file-input"
                className={[
                  'block py-10 border border-dashed border-line rounded-lg text-center cursor-pointer transition-colors',
                  busy ? 'bg-surface-alt' : 'hover:border-ink-subtle hover:bg-surface-alt/40',
                ].join(' ')}
              >
                {busy ? (
                  <span className="inline-flex items-center gap-2 text-sm text-ink-muted">
                    <RefreshCw size={14} className="animate-spin" /> Uploading…
                  </span>
                ) : (
                  <span className="flex flex-col items-center gap-1.5 text-sm text-ink-muted">
                    <ImageIcon size={20} className="text-ink-subtle" />
                    Click to upload an image
                    <span className="text-2xs text-ink-subtle">Recommended 1080×1920 (9:16)</span>
                  </span>
                )}
              </label>
            </div>
          )}

          {/* Preview of current pick — appears in both tabs once chosen */}
          {previewUrl && (
            <div className="pt-2 border-t border-line">
              <div className="text-xs font-medium uppercase tracking-wider text-ink-subtle mb-2">
                Current cover
              </div>
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={previewUrl}
                  alt="Cover"
                  className="w-16 h-28 object-cover rounded-lg border border-line bg-black"
                />
                <button
                  onClick={() => setPickedUploadId(null)}
                  className="text-xs text-danger hover:underline"
                >
                  Remove cover
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="px-3 py-2 rounded-lg bg-danger/10 border border-danger/20 text-xs text-danger">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line bg-surface-alt/30">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm font-medium text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            onClick={() => { onPick(pickedUploadId); onClose(); }}
            disabled={busy}
            className="px-4 py-1.5 text-sm font-medium rounded-lg bg-ink text-white hover:bg-ink/90 disabled:opacity-50"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
