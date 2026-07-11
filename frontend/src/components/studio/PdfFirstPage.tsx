'use client';

/**
 * PdfFirstPage — renders the first page of a PDF to a canvas so previews can
 * show the actual page (like LinkedIn's "Share a document" thumbnail) instead
 * of a generic file card.
 *
 * pdf.js is loaded from cdnjs at runtime (it isn't a build dependency, and the
 * live container has no server-side PDF rasteriser). If loading or rendering
 * fails for any reason, `onFail` lets the caller fall back to a document card —
 * we never show a broken state.
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const PDFJS_VERSION = '4.0.379';
const PDFJS_SRC = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.mjs`;
const PDFJS_WORKER = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.mjs`;

// Cache the module promise so we only load pdf.js once per session.
let pdfjsPromise: Promise<any> | null = null;
function loadPdfjs(): Promise<any> {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = import(/* webpackIgnore: true */ PDFJS_SRC).then((mod) => {
    const lib = mod.default ?? mod;
    try {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    } catch {
      /* ignore — some builds expose it differently */
    }
    return lib;
  });
  return pdfjsPromise;
}

interface Props {
  /** Direct URL to the PDF file. */
  src: string;
  className?: string;
  /** Called if the page can't be rendered, so the caller can fall back. */
  onFail?: () => void;
  /** Max pages to render (guards against huge PDFs). Default 20. */
  maxPages?: number;
}

export function PdfFirstPage({ src, className = '', onFail, maxPages = 20 }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [pages, setPages] = useState<string[]>([]); // rendered page data URLs
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPages([]);
    setIdx(0);
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const doc = await pdfjs.getDocument(src).promise;
        if (cancelled) return;
        const count = Math.min(doc.numPages, maxPages);
        const targetWidth = containerRef.current?.clientWidth || 500;
        const rendered: string[] = [];
        for (let n = 1; n <= count; n++) {
          if (cancelled) return;
          const page = await doc.getPage(n);
          const viewport0 = page.getViewport({ scale: 1 });
          const scale = targetWidth / viewport0.width;
          const viewport = page.getViewport({ scale: Math.max(scale, 0.1) });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport }).promise;
          rendered.push(canvas.toDataURL('image/jpeg', 0.85));
          // Progressive: show pages as they finish.
          if (!cancelled) setPages([...rendered]);
        }
      } catch {
        if (cancelled) return;
        setFailed(true);
        onFail?.();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src, onFail, maxPages]);

  if (failed) return null;

  const total = pages.length;
  const go = (delta: number) => setIdx((i) => Math.min(Math.max(i + delta, 0), total - 1));

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {total === 0 ? (
        <div className="flex aspect-[4/3] w-full items-center justify-center bg-black/5 text-xs text-ink-subtle">
          Loading document…
        </div>
      ) : (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={pages[idx]} alt={`Page ${idx + 1}`} className="w-full block bg-white" />

          {/* Page counter */}
          <div className="absolute top-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-2xs font-medium text-white">
            {idx + 1} / {total}
          </div>

          {/* Prev / next arrows (only when more than one page) */}
          {total > 1 && (
            <>
              {idx > 0 && (
                <button
                  type="button"
                  onClick={() => go(-1)}
                  aria-label="Previous page"
                  className="absolute left-2 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/70"
                >
                  <ChevronLeft size={16} />
                </button>
              )}
              {idx < total - 1 && (
                <button
                  type="button"
                  onClick={() => go(1)}
                  aria-label="Next page"
                  className="absolute right-2 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/70"
                >
                  <ChevronRight size={16} />
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
