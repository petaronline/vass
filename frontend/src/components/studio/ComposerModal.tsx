'use client';

/**
 * ComposerModal — full-screen post composer.
 *
 * Patch 4.27 changes:
 *   - Textarea auto-resizes: ~3 rows minimum, grows to ~8 rows max.
 *   - Multi-file media: up to 10 images (carousel) OR a single video.
 *     Tagged per item; mixing is blocked at the UI layer with a toast.
 *   - Preview pane responds to chip click in ALL modes (not just
 *     customize-per-network). Active chip is highlighted in both modes.
 *   - FB and IG previews now render video + carousel.
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import {
  X,
  Image as ImageIcon,
  Trash2,
  RefreshCw,
  Send,
  Plus,
  Check,
  Facebook,
  Instagram,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Search,
  Layers,
  PlayCircle,
  CalendarClock,
  Users,
  Film,
  AtSign,
  Music2,
  Linkedin,
  FileText,
} from 'lucide-react';
import {
  organicAccounts,
  organicPosts,
  organicIdeas,
  uploads,
  brandHashtags as brandHashtagsApi,
  OrganicAccount,
  OrganicPlatform,
  Upload,
  ApiError,
  PublishPostInput,
} from '@/lib/api';
import { getActiveBrandId, getActiveScope } from '@/components/BrandSelector';
import { FacebookPreview, PreviewMediaItem } from './FacebookPreview';
import { ComposerSection } from './ComposerSection';
import { VideoPlayer } from './VideoPlayer';
import { InstagramPreview } from './InstagramPreview';
import { ThreadsPreview } from './ThreadsPreview';
import { TikTokPreview } from './TikTokPreview';
import { LinkedInPreview } from './LinkedInPreview';
import { ComposerToolbar } from './ComposerToolbar';
import { SchedulePicker } from './SchedulePicker';
import { HighlightedTextarea } from './HighlightedTextarea';
import { FirstCommentField } from './FirstCommentField';
import { CoverPicker } from './CoverPicker';
import { TopicTagField } from './TopicTagField';
import { ReplyChainComposer } from './ReplyChainComposer';

interface Toast { id: number; type: 'success' | 'error'; message: string; }
let toastCounter = 0;

interface PlatformConfig {
  id: OrganicPlatform;
  label: string;
  icon: typeof Facebook;
  iconColor: string;
  charLimit: number;
  requiresMedia: boolean;
}

const PLATFORM_BY_ID: Record<OrganicPlatform, PlatformConfig> = {
  facebook_page: { id: 'facebook_page', label: 'Facebook',  icon: Facebook,  iconColor: '#1877F2', charLimit: 63206, requiresMedia: false },
  instagram:     { id: 'instagram',     label: 'Instagram', icon: Instagram, iconColor: '#E1306C', charLimit: 2200,  requiresMedia: true  },
  threads:       { id: 'threads',       label: 'Threads',   icon: AtSign,    iconColor: '#000000', charLimit: 500,   requiresMedia: false },
  tiktok:        { id: 'tiktok',        label: 'TikTok',    icon: Music2,    iconColor: '#000000', charLimit: 2200,  requiresMedia: true  },
  linkedin:      { id: 'linkedin',      label: 'LinkedIn',  icon: Linkedin,  iconColor: '#0A66C2', charLimit: 3000,  requiresMedia: false },
};

const FALLBACK_LIMIT = 8000;
const MAX_CAROUSEL = 10;

/** A media item attached to the post (one of: image — possibly multi —
 *  OR a single video). */
interface MediaItem {
  upload: Upload;
  kind: 'image' | 'video' | 'document';
}

/** TikTok per-post settings — defined locally so the composer doesn't depend
 *  on these fields being present in api.ts's shared types. (Some deployed
 *  builds predate the 4.43.1 api.ts additions; reading/writing through these
 *  local shapes keeps the composer compiling regardless.) */
type TikTokPrivacy =
  | 'PUBLIC_TO_EVERYONE'
  | 'MUTUAL_FOLLOW_FRIENDS'
  | 'FOLLOWER_OF_CREATOR'
  | 'SELF_ONLY';

/** Shape of the TikTok fields the composer reads off a loaded post.detail.
 *  All optional — older posts / older API responses won't carry them. */
interface TikTokPostFields {
  tiktokPrivacy?: TikTokPrivacy | null;
  tiktokCommercialContent?: boolean | null;
  tiktokYourBrand?: boolean | null;
  tiktokBrandedContent?: boolean | null;
  tiktokDisableComment?: boolean | null;
  tiktokDisableDuet?: boolean | null;
  tiktokDisableStitch?: boolean | null;
}

/** Shape of the TikTok block the composer writes into the publish payload. */
interface TikTokPublishInput {
  privacy?: TikTokPrivacy;
  commercialContent?: boolean;
  yourBrand?: boolean;
  brandedContent?: boolean;
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
}

/** A single reply post in a Threads chain. Mirrors the head post's
 *  body+media but with a per-reply 500 char limit. Reply media is
 *  separate from the head's media. */
interface ReplyDraft {
  body: string;
  mediaItems: MediaItem[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  onPublished?: () => void;
  /** Patch 4.37.0: when set, the modal opens in edit mode. It fetches
   *  the draft's data and prefills body, media, targets, scheduling,
   *  collaborators, etc. "Save as draft" now PATCHes this id rather
   *  than creating a new row. */
  draftId?: string | null;
  /** Patch 4.37.1: prefill data sourced from an Idea. The composer
   *  initializes its body + media from this seed, then (on successful
   *  draft / publish / schedule) deletes the originating idea via the
   *  Ideas API. Mutually exclusive with `draftId` — the composer will
   *  prefer draftId if both are passed. */
  ideaSeed?: ComposerIdeaSeed | null;
  /** Patch 4.41.0: when set, the modal opens to edit an already
   *  SCHEDULED post. Like draftId it fetches + prefills the post
   *  (including its scheduled time), but on save it PATCHes in place
   *  and re-queues the publish job instead of creating a new row +
   *  deleting the old one. Mutually exclusive with draftId/ideaSeed;
   *  if set, it takes precedence. */
  scheduledPostId?: string | null;
}

/** A snapshot of an Idea, suitable for prefilling the composer. The
 *  link URL is intentionally omitted — most platforms strip URLs from
 *  bodies, and we don't want to surprise the user. */
export interface ComposerIdeaSeed {
  /** Idea id — used by the composer to delete the idea after a
   *  successful save (draft, schedule, or publish). */
  ideaId: string;
  /** Optional title; the composer prepends it to the body separated
   *  by a blank line. */
  title: string | null;
  body: string;
  /** A single media item, already uploaded. The composer treats it
   *  identically to a user-attached file. */
  upload: Upload | null;
  mediaKind: 'image' | 'video' | 'document' | null;
}

export function ComposerModal({ open, onClose, onPublished, draftId, ideaSeed, scheduledPostId }: Props) {
  // Patch 4.41.0: the post id we're editing, whether it came in as a
  // draft or a scheduled post. The load effect uses this to fetch +
  // prefill; the save path branches on `isScheduledEdit`.
  const editId = scheduledPostId ?? draftId ?? null;
  const isScheduledEdit = !!scheduledPostId;
  const [accounts, setAccounts] = useState<OrganicAccount[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [customizePerNetwork, setCustomizePerNetwork] = useState(false);
  const [sharedBody, setSharedBody] = useState('');
  const [bodies, setBodies] = useState<Record<string, string>>({});
  /** Which chip drives the preview AND, in customize mode, which textarea
   *  is editable. Set from chip click in ALL modes (4.27). */
  const [activeChipId, setActiveChipId] = useState<string | null>(null);

  /** Ordered media items. All-image (1-10) OR single video. */
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  // Per-network media overrides, keyed by accountId (mirrors `bodies`).
  // Only consulted when customizePerNetwork is on. A missing key means the
  // target uses the shared `mediaItems`.
  const [mediaByTarget, setMediaByTarget] = useState<Record<string, MediaItem[]>>({});
  // Patch 4.42.0: index of the carousel thumb being dragged (reorder).
  const [dragThumbIdx, setDragThumbIdx] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{done: number; total: number; pct: number} | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addMoreInputRef = useRef<HTMLInputElement>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');

  const [publishing, setPublishing] = useState(false);
  // Patch 4.37.0: separate spinner for the "Save as draft" button —
  // so it can show progress without disabling Publish/Schedule.
  const [savingDraft, setSavingDraft] = useState(false);
  // The draft id this composer is editing (if any). Set from the prop
  // on open; cleared on Publish or Schedule (since the draft was
  // promoted into a real post).
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  // Patch 4.37.1: the idea this compose was seeded from (if any). On
  // a successful draft / publish / schedule, we delete the idea so it
  // doesn't double-count as "still pending" in the Ideas list.
  const [seededIdeaId, setSeededIdeaId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Patch 4.29: brand hashtags loaded for the active brand. Empty when
  // active brand is "all" or the brand has no presets.
  const [brandHashtagList, setBrandHashtagList] = useState<string[]>([]);

  // Patch 4.29: scheduling. When set, footer's "Publish now" turns into
  // a "Scheduled — change time" affordance, and the actual publish call
  // includes the ISO datetime.
  const [scheduledFor, setScheduledFor] = useState<string | null>(null);
  const [schedulePickerOpen, setSchedulePickerOpen] = useState(false);

  // Patch 4.31: first comment + collaborators.
  // - first comment is always visible under the toolbar.
  // - collaborators is IG-only — surfaces when an IG profile is selected.
  // (Location tagging was removed in 4.32.5 — Meta's /pages/search now
  //  requires Page Public Metadata Access, an app-review-only feature.)
  const [firstComment, setFirstComment] = useState('');
  const [collaborators, setCollaborators] = useState<string[]>([]);

  // Patch 4.33: optional custom cover thumbnail for video posts (Reels).
  // Holds an upload id pointing to the cover image. Picker modal is
  // mounted lazily.
  const [coverUploadId, setCoverUploadId] = useState<string | null>(null);
  const [coverPickerOpen, setCoverPickerOpen] = useState(false);

  // Patch 4.34: Threads-specific composer state.
  //   - topicTag    : single string, head-post-only, max 50 chars
  //   - replyChain  : up to 4 reply posts (head + 4 = 5 total)
  // Both render only when at least one Threads target is selected, and
  // are silently dropped from the publish payload for non-Threads
  // accounts on the backend.
  const [topicTag, setTopicTag] = useState('');
  const [documentTitle, setDocumentTitle] = useState('');
  // ─── TikTok per-post settings (Patch 4.43.1) ──────────────────────
  // privacy + commercial-disclosure + interaction toggles. Sent in the
  // publish payload as `tiktok`. Creator info (name/avatar + allowed
  // privacy levels) is fetched per connected TikTok account and shown
  // in the composer to satisfy TikTok's mandatory pre-post UX.
  const [ttPrivacy, setTtPrivacy] = useState<
    'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY'
  >('SELF_ONLY');
  const [ttCommercial, setTtCommercial] = useState(false);
  const [ttYourBrand, setTtYourBrand] = useState(false);
  const [ttBrandedContent, setTtBrandedContent] = useState(false);
  const [ttDisableComment, setTtDisableComment] = useState(false);
  const [ttDisableDuet, setTtDisableDuet] = useState(false);
  const [ttDisableStitch, setTtDisableStitch] = useState(false);
  const [ttCreatorInfo, setTtCreatorInfo] = useState<{
    creatorNickname: string | null;
    creatorUsername: string | null;
    creatorAvatarUrl: string | null;
    privacyOptions: string[];
    commentDisabled: boolean;
    duetDisabled: boolean;
    stitchDisabled: boolean;
    maxVideoSeconds: number | null;
  } | null>(null);
  const [ttCreatorLoading, setTtCreatorLoading] = useState(false);
  const [ttCreatorError, setTtCreatorError] = useState<string | null>(null);
  const [replyChain, setReplyChain] = useState<ReplyDraft[]>([]);

  const sharedRef = useRef<HTMLTextAreaElement | null>(null);
  const perRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());

  const addToast = useCallback((type: Toast['type'], message: string) => {
    const id = ++toastCounter;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
  }, []);

  // ─── Load accounts when the modal opens ──────────────────────────────────

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    organicAccounts
      .list()
      .then((r) => {
        if (cancelled) return;
        setAccounts(r.accounts);
        // Patch 4.37.5: pre-select based on the multi-scope:
        //   - 'all' → leave empty (don't dump everything)
        //   - mixed brand + profile items → union: every account in
        //     each picked brand, plus each picked profile account
        const activeScope = getActiveScope();
        if (activeScope.type === 'multi') {
          const picked = new Set<string>();
          for (const item of activeScope.items) {
            if (item.type === 'profile') {
              picked.add(item.id);
            } else {
              for (const a of r.accounts) {
                if (a.brandId === item.id) picked.add(a.id);
              }
            }
          }
          const ids = Array.from(picked);
          setSelectedIds(ids);
          if (ids.length > 0) setActiveChipId(ids[0]);
        }
      })
      .catch((err) => { if (!cancelled) addToast('error', err instanceof ApiError ? err.message : 'Failed to load profiles'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, addToast]);

  // Close on Esc
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !publishing) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, publishing, onClose]);

  // Lock body scroll while open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // Reset state when the modal opens fresh. Pre-selection happens later
  // in the accounts-load effect above (it needs the accounts list).
  useEffect(() => {
    if (!open) return;
    setSelectedIds([]);
    setCustomizePerNetwork(false);
    // If seeded from an Idea, the body starts from the idea's
    // title+body (and the link is intentionally dropped). Drafts
    // override this in their own loader effect below.
    if (!draftId && ideaSeed) {
      const composed = ideaSeed.title && ideaSeed.title.trim()
        ? `${ideaSeed.title.trim()}\n\n${ideaSeed.body ?? ''}`
        : (ideaSeed.body ?? '');
      setSharedBody(composed);
    } else {
      setSharedBody('');
    }
    setBodies({});
    setMediaByTarget({});
    setActiveChipId(null);
    // Same idea-seed precedence rule for media.
    if (!draftId && ideaSeed && ideaSeed.upload && ideaSeed.mediaKind) {
      setMediaItems([{ upload: ideaSeed.upload, kind: ideaSeed.mediaKind }]);
    } else {
      setMediaItems([]);
    }
    setPickerOpen(false);
    setPickerQuery('');
    setBrandHashtagList([]);
    setScheduledFor(null);
    setSchedulePickerOpen(false);
    setFirstComment('');
    setCollaborators([]);
    setCoverUploadId(null);
    setCoverPickerOpen(false);
    setTopicTag('');
    setDocumentTitle('');
    setReplyChain([]);
    // Track the seeded idea id only when seeding (not when editing a
    // draft). Drafts take precedence in the loader effect.
    setSeededIdeaId(!draftId && ideaSeed ? ideaSeed.ideaId : null);
    setEditingDraftId(draftId ?? null);
    setSavingDraft(false);
  }, [open, draftId, ideaSeed]);

  // Patch 4.37.0: when opening to edit an existing draft, fetch it and
  // prefill all the relevant state. We rely on selectedIds being
  // pre-seeded by the accounts-load effect — it doesn't know which IDs
  // belong to the draft, so we override here once the accounts list
  // has loaded.
  useEffect(() => {
    if (!open || !editId) return;
    let cancelled = false;
    setDraftLoading(true);
    organicPosts
      .get(editId)
      .then((r) => {
        if (cancelled) return;
        const p = r.post;
        setSharedBody(p.body ?? '');
        setFirstComment(p.firstComment ?? '');
        setCollaborators(p.collaborators ?? []);
        setCoverUploadId(p.coverUploadId);
        setTopicTag(p.topicTag ?? '');
        setDocumentTitle(p.documentTitle ?? '');
        // Patch 4.43.1: prefill TikTok per-post settings when editing.
        // Read through a local cast so this compiles even where api.ts's
        // OrganicPostDetail doesn't (yet) declare the tiktok fields.
        const ptt = p as typeof p & TikTokPostFields;
        if (ptt.tiktokPrivacy) setTtPrivacy(ptt.tiktokPrivacy);
        setTtCommercial(ptt.tiktokCommercialContent ?? false);
        setTtYourBrand(ptt.tiktokYourBrand ?? false);
        setTtBrandedContent(ptt.tiktokBrandedContent ?? false);
        setTtDisableComment(ptt.tiktokDisableComment ?? false);
        setTtDisableDuet(ptt.tiktokDisableDuet ?? false);
        setTtDisableStitch(ptt.tiktokDisableStitch ?? false);
        // Patch 4.41.0: when editing a scheduled post, prefill its time
        // so the schedule isn't lost on save. (Drafts have no time.)
        if (isScheduledEdit && p.scheduledFor) {
          setScheduledFor(p.scheduledFor);
        }
        // Reply chain bodies — media gets attached after we re-hydrate
        // from r.media (separate array, indexed by replyIndex).
        const chain: ReplyDraft[] = (p.replyChain ?? []).map((rc) => ({
          body: rc.body ?? '',
          mediaItems: [],
        }));
        // Reattach media items by replyIndex (0 = head, 1+ = replies).
        // We construct minimal Upload objects — the composer only reads
        // .upload.id (uploads.fileUrl uses just the id), so casting is safe.
        const makeItem = (m: typeof r.media[number]): MediaItem => ({
          upload: {
            id: m.uploadId,
            contentType: m.contentType ?? '',
            widthPx: m.widthPx ?? null,
            heightPx: m.heightPx ?? null,
          } as unknown as Upload,
          kind: m.kind,
        });
        const headMedia: MediaItem[] = [];
        for (const m of r.media) {
          const item = makeItem(m);
          if (m.replyIndex === 0) {
            headMedia[m.sortOrder] = item;
          } else if (chain[m.replyIndex - 1]) {
            const arr = chain[m.replyIndex - 1].mediaItems;
            arr[m.sortOrder] = item;
          }
        }
        // Drop sparse holes (shouldn't happen but be defensive).
        setMediaItems(headMedia.filter(Boolean));
        for (const link of chain) {
          link.mediaItems = link.mediaItems.filter(Boolean);
        }
        setReplyChain(chain);
        // Restore target selection.
        const targetIds = r.targets.map((t) => t.accountId);
        setSelectedIds(targetIds);
        // Restore per-target body overrides (turn on customizePerNetwork
        // if any target has its own body).
        const overrides: Record<string, string> = {};
        let anyOverride = false;
        for (const t of r.targets) {
          if (t.bodyOverride !== null && t.bodyOverride !== p.body) {
            overrides[t.accountId] = t.bodyOverride;
            anyOverride = true;
          }
        }
        if (anyOverride) {
          setCustomizePerNetwork(true);
          setBodies(overrides);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        addToast('error', err instanceof ApiError ? err.message : 'Failed to load post');
        onClose();
      })
      .finally(() => {
        if (!cancelled) setDraftLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editId]);

  // ─── Active media (shared vs per-network) ──────────────────────────────
  // When customizing per network, the composer edits the ACTIVE chip's media;
  // otherwise the shared media. Wrapping it keeps the media UI agnostic.
  const activeMedia: MediaItem[] =
    customizePerNetwork && activeChipId
      ? (mediaByTarget[activeChipId] ?? [])
      : mediaItems;

  const setActiveMedia = (updater: (prev: MediaItem[]) => MediaItem[]) => {
    if (customizePerNetwork && activeChipId) {
      const key = activeChipId;
      setMediaByTarget((m) => ({ ...m, [key]: updater(m[key] ?? []) }));
    } else {
      setMediaItems(updater);
    }
  };

  // Cover is only meaningful for video posts. If the user removes the
  // video or swaps to images, clear the orphaned cover selection.
  useEffect(() => {
    const isVideo = activeMedia.length > 0 && activeMedia[0].kind === 'video';
    if (!isVideo && coverUploadId !== null) {
      setCoverUploadId(null);
    }
  }, [mediaItems, coverUploadId]);

  // Load brand hashtags when active brand changes (or on open with a brand).
  useEffect(() => {
    if (!open) {
      setBrandHashtagList([]);
      return;
    }
    const brandId = getActiveBrandId();
    if (brandId === 'all') {
      setBrandHashtagList([]);
      return;
    }
    let cancelled = false;
    brandHashtagsApi
      .list(brandId)
      .then((r) => { if (!cancelled) setBrandHashtagList(r.hashtags.map((h) => h.tag)); })
      .catch(() => { if (!cancelled) setBrandHashtagList([]); });
    return () => { cancelled = true; };
  }, [open]);

  // ─── Derived ─────────────────────────────────────────────────────────────

  const activeBrandId = open ? getActiveBrandId() : 'all';
  const visibleAccounts = accounts.filter((a) =>
    activeBrandId === 'all' ? true : a.brandId === activeBrandId
  );

  const selectedAccounts = selectedIds
    .map((id) => accounts.find((a) => a.id === id))
    .filter((a): a is OrganicAccount => !!a);

  const selectedHasInstagram = selectedAccounts.some((a) => a.platform === 'instagram');
  const selectedHasThreads = selectedAccounts.some((a) => a.platform === 'threads');
  const selectedHasFacebook = selectedAccounts.some((a) => a.platform === 'facebook_page');
  const selectedTikTokAccounts = selectedAccounts.filter((a) => a.platform === 'tiktok');
  const selectedHasTikTok = selectedTikTokAccounts.length > 0;
  const firstTikTokId = selectedTikTokAccounts[0]?.id ?? null;

  // Fetch TikTok creator info when a TikTok account becomes selected.
  // TikTok requires showing the creator's name/avatar + the privacy
  // levels they allow before posting. Re-runs when the selected TikTok
  // account changes. Clears when no TikTok target is selected.
  useEffect(() => {
    if (!firstTikTokId) {
      setTtCreatorInfo(null);
      setTtCreatorError(null);
      return;
    }
    let cancelled = false;
    setTtCreatorLoading(true);
    setTtCreatorError(null);
    organicAccounts
      .getTikTokCreatorInfo(firstTikTokId)
      .then((info) => {
        if (cancelled) return;
        setTtCreatorInfo(info);
        // Default privacy to the first allowed option if our current
        // choice isn't permitted for this creator.
        if (info.privacyOptions.length > 0 && !info.privacyOptions.includes(ttPrivacy)) {
          setTtPrivacy(info.privacyOptions[0] as typeof ttPrivacy);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setTtCreatorError(err instanceof Error ? err.message : 'Failed to load TikTok creator info');
        setTtCreatorInfo(null);
      })
      .finally(() => {
        if (!cancelled) setTtCreatorLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstTikTokId]);

  const strictestLimit = selectedAccounts.length === 0
    ? FALLBACK_LIMIT
    : Math.min(...selectedAccounts.map((a) => PLATFORM_BY_ID[a.platform]?.charLimit ?? FALLBACK_LIMIT));

  /** The chip whose preview is currently rendered. In shared mode this is
   *  also clickable to switch the preview; in per-network mode it's the
   *  active editor as well. Falls back to first selected. */
  const previewChip = activeChipId
    ? selectedAccounts.find((a) => a.id === activeChipId) ?? null
    : selectedAccounts[0] ?? null;

  const counterBody = customizePerNetwork && activeChipId
    ? (bodies[activeChipId] ?? '')
    : sharedBody;
  const counterLimit = customizePerNetwork && previewChip
    ? (PLATFORM_BY_ID[previewChip.platform]?.charLimit ?? FALLBACK_LIMIT)
    : strictestLimit;

  const anySelected = selectedIds.length > 0;

  // Effective media for a given target (per-network override if customizing
  // and set, else the shared media).
  const mediaFor = (accountId: string): MediaItem[] =>
    customizePerNetwork && mediaByTarget[accountId] ? mediaByTarget[accountId] : mediaItems;

  const anyMediaPresent =
    mediaItems.length > 0 ||
    (customizePerNetwork && Object.values(mediaByTarget).some((arr) => arr.length > 0));

  const hasContent = customizePerNetwork
    ? Object.values(bodies).some((v) => v.trim().length > 0) || anyMediaPresent
    : sharedBody.trim().length > 0 || mediaItems.length > 0;
  const overLimit = customizePerNetwork
    ? selectedAccounts.some((a) => (bodies[a.id]?.length ?? 0) > (PLATFORM_BY_ID[a.platform]?.charLimit ?? FALLBACK_LIMIT))
    : sharedBody.length > strictestLimit;
  // If the ONLY selected accounts are IG with no media (for their effective
  // media set), there's nothing to publish — disable in that one case.
  const allSelectedAreBlockedIg =
    selectedAccounts.length > 0 &&
    selectedAccounts.every((a) => a.platform === 'instagram' && mediaFor(a.id).length === 0);

  // PDF document rules, evaluated per target: any target whose effective
  // media is a document must (a) be LinkedIn and (b) have a title.
  const docTargets = selectedAccounts.filter((a) => mediaFor(a.id)[0]?.kind === 'document');
  const docOnNonLinkedIn = docTargets.some((a) => a.platform !== 'linkedin');
  const docMissingTitle =
    docTargets.length > 0 &&
    !documentTitle.trim() &&
    // per-network title fallback handled server-side; here we just require
    // the composer-level title when any document target exists.
    true;
  const canPublish =
    anySelected &&
    hasContent &&
    !allSelectedAreBlockedIg &&
    !overLimit &&
    !docOnNonLinkedIn &&
    !docMissingTitle;

  // Media derivations
  const mediaIsVideo = activeMedia.length > 0 && activeMedia[0].kind === 'video';
  const mediaIsImage = activeMedia.length > 0 && activeMedia[0].kind === 'image';
  const hasDocument = activeMedia.length > 0 && activeMedia[0].kind === 'document';
  const canAddMore = mediaIsImage && activeMedia.length < MAX_CAROUSEL;
  // A document (PDF) post is LinkedIn-only and needs a title.
  const documentTitleMissing = hasDocument && !documentTitle.trim();

  // ─── Selection helpers ──────────────────────────────────────────────────

  /**
   * Chip click TOGGLES selection. Clicking a selected chip deselects it
   * (so 4.27's preview-driver concept moves to the dedicated switcher in
   * the preview pane). If we just deselected the active preview chip,
   * we snap the preview to whatever's still selected.
   */
  const handleChipClick = (id: string) => {
    if (selectedIds.includes(id)) {
      handleRemoveProfile(id);
    } else {
      handleAddProfile(id);
    }
  };

  const handleAddProfile = (id: string) => {
    if (selectedIds.includes(id)) return;
    setSelectedIds((prev) => [...prev, id]);
    // Auto-activate the first added profile so the preview lights up
    if (selectedIds.length === 0) setActiveChipId(id);
  };

  const handleRemoveProfile = (id: string) => {
    setSelectedIds((prev) => prev.filter((x) => x !== id));
    setBodies((b) => {
      const c = { ...b };
      delete c[id];
      return c;
    });
    if (activeChipId === id) {
      // Snap active to whatever's next
      const remaining = selectedIds.filter((x) => x !== id);
      setActiveChipId(remaining[0] ?? null);
    }
  };

  // ─── Customize toggle ───────────────────────────────────────────────────

  const handleCustomizeToggle = () => {
    if (!customizePerNetwork) {
      const seeded: Record<string, string> = {};
      const seededMedia: Record<string, MediaItem[]> = {};
      selectedIds.forEach((id) => {
        seeded[id] = sharedBody;
        // Seed each network's media from the current shared media so the
        // user starts from the original upload and only diverges if they want.
        seededMedia[id] = [...mediaItems];
      });
      setBodies(seeded);
      setMediaByTarget(seededMedia);
      if (!activeChipId) setActiveChipId(selectedIds[0] ?? null);
      setCustomizePerNetwork(true);
    } else {
      const values = Object.values(bodies);
      const allSame = values.every((v) => v === values[0]);
      if (!allSame) {
        if (!confirm('Switching back to shared text will keep only the first version. Continue?')) return;
      }
      setSharedBody(bodies[selectedIds[0]] ?? sharedBody);
      // Collapse back to the first network's media as the shared set.
      const firstMedia = mediaByTarget[selectedIds[0]];
      if (firstMedia) setMediaItems(firstMedia);
      setBodies({});
      setMediaByTarget({});
      setCustomizePerNetwork(false);
    }
  };

  // ─── Insertion helpers (emoji, hashtag) ────────────────────────────────

  const insertIntoActive = (text: string) => {
    if (customizePerNetwork && activeChipId) {
      const el = perRefs.current.get(activeChipId);
      const current = bodies[activeChipId] ?? '';
      const start = el?.selectionStart ?? current.length;
      const end = el?.selectionEnd ?? current.length;
      const next = current.slice(0, start) + text + current.slice(end);
      setBodies((b) => ({ ...b, [activeChipId]: next }));
      requestAnimationFrame(() => {
        const el2 = perRefs.current.get(activeChipId);
        if (el2) {
          el2.focus();
          el2.selectionStart = el2.selectionEnd = start + text.length;
        }
      });
    } else {
      const el = sharedRef.current;
      const start = el?.selectionStart ?? sharedBody.length;
      const end = el?.selectionEnd ?? sharedBody.length;
      const next = sharedBody.slice(0, start) + text + sharedBody.slice(end);
      setSharedBody(next);
      requestAnimationFrame(() => {
        const el2 = sharedRef.current;
        if (el2) {
          el2.focus();
          el2.selectionStart = el2.selectionEnd = start + text.length;
        }
      });
    }
  };

  const handleInsertEmoji = (emoji: string) => insertIntoActive(emoji);
  /** Generic text insert at cursor — used for hashtags (single or bulk). */
  const handleInsertText = (text: string) => insertIntoActive(text);

  // ─── File upload ────────────────────────────────────────────────────────

  /** Classify a File as image/video; returns null for unsupported. */
  const classify = (file: File): 'image' | 'video' | 'document' | null => {
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('video/')) return 'video';
    if (file.type === 'application/pdf') return 'document';
    return null;
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    // Resolve and validate the incoming batch
    const incoming: { file: File; kind: 'image' | 'video' | 'document' }[] = [];
    for (const f of Array.from(files)) {
      const k = classify(f);
      if (!k) {
        addToast('error', `Unsupported file type: ${f.name}`);
        return;
      }
      incoming.push({ file: f, kind: k });
    }

    // Determine the effective kind of the post AFTER adding these files
    const existingKind = activeMedia[0]?.kind ?? null;
    const incomingHasVideo = incoming.some((i) => i.kind === 'video');
    const incomingHasImage = incoming.some((i) => i.kind === 'image');
    const incomingHasDocument = incoming.some((i) => i.kind === 'document');

    // Documents (PDF) are LinkedIn document posts: exactly one file, no mixing.
    if (incomingHasDocument) {
      if (incoming.length > 1 || incomingHasImage || incomingHasVideo) {
        addToast('error', 'A PDF document post is a single file — no other media.');
        return;
      }
      if (activeMedia.length > 0) {
        addToast('error', 'Remove the current media first to attach a PDF.');
        return;
      }
    } else if (existingKind === 'document') {
      addToast('error', 'This post has a PDF attached. Remove it to add other media.');
      return;
    }

    // Block mixing image + video
    if (incomingHasVideo && incomingHasImage) {
      addToast('error', 'A post can be multiple images OR a single video — not both.');
      return;
    }
    const incomingKind: 'image' | 'video' | 'document' = incomingHasDocument
      ? 'document'
      : incomingHasVideo
      ? 'video'
      : 'image';

    if (existingKind && existingKind !== incomingKind && incomingKind !== 'document') {
      addToast('error', `Already have ${existingKind === 'image' ? 'images' : 'a video'} attached. Remove first to switch types.`);
      return;
    }

    // Video constraint: only one
    if (incomingKind === 'video') {
      if (incoming.length > 1 || activeMedia.length > 0) {
        addToast('error', 'Only one video per post is supported.');
        return;
      }
    }

    // Image constraint: max 10 total
    if (incomingKind === 'image') {
      const totalAfter = activeMedia.length + incoming.length;
      if (totalAfter > MAX_CAROUSEL) {
        addToast('error', `Max ${MAX_CAROUSEL} images per post. You're trying to add ${incoming.length} on top of ${activeMedia.length}.`);
        return;
      }
    }

    // Upload sequentially with per-file progress
    setUploading(true);
    const added: MediaItem[] = [];
    try {
      for (let i = 0; i < incoming.length; i++) {
        const item = incoming[i];
        setUploadProgress({ done: i, total: incoming.length, pct: 0 });
        const { upload: u } = await uploads.upload(item.file, (frac) => {
          setUploadProgress({ done: i, total: incoming.length, pct: Math.round(frac * 100) });
        });
        added.push({ upload: u, kind: item.kind });
      }
      setActiveMedia((prev) => [...prev, ...added]);
    } catch (err) {
      addToast('error', err instanceof ApiError ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      setUploadProgress(null);
      // Reset input so re-uploading the same file works
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (addMoreInputRef.current) addMoreInputRef.current.value = '';
    }
  };

  const removeMediaItem = (idx: number) => {
    setActiveMedia((prev) => prev.filter((_, i) => i !== idx));
  };

  // Patch 4.42.0: drag-to-reorder carousel thumbnails. Moves the item
  // at `from` to position `to`, shifting the rest. Carousel order is the
  // array order — index 0 is the first slide.
  const moveMediaItem = (from: number, to: number) => {
    if (from === to) return;
    setActiveMedia((prev) => {
      if (from < 0 || from >= prev.length || to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  // ─── Publish ────────────────────────────────────────────────────────────

  const handlePublish = async () => {
    if (!canPublish) return;
    setPublishing(true);
    try {
      // Determine which selected targets should be silently dropped.
      // IG accounts with no effective media (IG's API rejects text-only).
      const skippedAccounts = selectedAccounts.filter(
        (a) => a.platform === 'instagram' && mediaFor(a.id).length === 0
      );
      const skippedIds = new Set(skippedAccounts.map((a) => a.id));
      const effectiveIds = selectedIds.filter((id) => !skippedIds.has(id));

      const targets = effectiveIds.map((id) => {
        const override = customizePerNetwork ? bodies[id] ?? '' : null;
        // Per-network media: only send an override when customizing AND this
        // target's media differs from the shared set.
        const tMedia = customizePerNetwork ? mediaByTarget[id] : undefined;
        const sharedSig = mediaItems.map((m) => m.upload.id).join(',');
        const tSig = (tMedia ?? []).map((m) => m.upload.id).join(',');
        const mediaOverride =
          customizePerNetwork && tMedia && tSig !== sharedSig
            ? tMedia.map((m) => ({ uploadId: m.upload.id, kind: m.kind }))
            : undefined;
        return {
          accountId: id,
          bodyOverride: override !== null && override !== sharedBody ? override : null,
          ...(mediaOverride ? { mediaItems: mediaOverride } : {}),
        };
      });
      const baseBody = customizePerNetwork
        ? bodies[effectiveIds[0]] ?? ''
        : sharedBody;

      // Patch 4.41.0: editing an already-scheduled post. PATCH in place
      // (the backend updates content/targets and re-queues the publish
      // job to scheduledFor). No new row, no delete — unlike the
      // draft-promotion path below.
      if (isScheduledEdit && editId) {
        if (!scheduledFor) {
          addToast('error', 'Pick a time to keep this post scheduled.');
          setPublishing(false);
          return;
        }
        const upd = await organicPosts.update(editId, {
          body: baseBody,
          mediaItems: mediaItems.map((m) => ({ uploadId: m.upload.id, kind: m.kind })),
          brandId: activeBrandId === 'all' ? null : activeBrandId,
          scheduledFor,
          firstComment: firstComment.trim() || null,
          collaborators: collaborators.length > 0 ? collaborators : null,
          coverUploadId,
          topicTag: topicTag.trim() || null,
          documentTitle: documentTitle.trim() || null,
          replyChain: replyChain.length > 0
            ? replyChain.map((r) => ({
                body: r.body,
                mediaItems: r.mediaItems.map((m) => ({ uploadId: m.upload.id, kind: m.kind })),
              }))
            : undefined,
          targets,
          asDraft: false,
          tiktok: selectedHasTikTok
            ? {
                privacy: ttPrivacy,
                commercialContent: ttCommercial,
                yourBrand: ttCommercial && ttYourBrand,
                brandedContent: ttCommercial && ttBrandedContent,
                disableComment: ttDisableComment,
                disableDuet: ttDisableDuet,
                disableStitch: ttDisableStitch,
              }
            : undefined,
        } as PublishPostInput & { tiktok?: TikTokPublishInput | null });
        const whenStr = upd.scheduledFor
          ? new Date(upd.scheduledFor).toLocaleString(undefined, {
              weekday: 'short', month: 'short', day: 'numeric',
              hour: 'numeric', minute: '2-digit',
            })
          : null;
        addToast('success', whenStr ? `Updated — scheduled for ${whenStr}.` : 'Post updated.');
        if (onPublished) onPublished();
        setTimeout(() => onClose(), 800);
        setPublishing(false);
        return;
      }

      const result = await organicPosts.publish({
        body: baseBody,
        mediaItems: mediaItems.map((m) => ({ uploadId: m.upload.id, kind: m.kind })),
        brandId: activeBrandId === 'all' ? null : activeBrandId,
        scheduledFor: scheduledFor, // null = publish-now path on the server
        firstComment: firstComment.trim() || null,
        collaborators: collaborators.length > 0 ? collaborators : null,
        coverUploadId: coverUploadId,
        // Threads-only fields. Backend drops them silently for non-Threads
        // targets, so it's safe to always send when the user filled them in.
        topicTag: topicTag.trim() || null,
        documentTitle: documentTitle.trim() || null,
        replyChain: replyChain.length > 0
          ? replyChain.map((r) => ({
              body: r.body,
              mediaItems: r.mediaItems.map((m) => ({
                uploadId: m.upload.id,
                kind: m.kind,
              })),
            }))
          : undefined,
        // TikTok-only settings. Backend ignores for non-TikTok targets.
        tiktok: selectedHasTikTok
          ? {
              privacy: ttPrivacy,
              commercialContent: ttCommercial,
              yourBrand: ttCommercial && ttYourBrand,
              brandedContent: ttCommercial && ttBrandedContent,
              disableComment: ttDisableComment,
              disableDuet: ttDisableDuet,
              disableStitch: ttDisableStitch,
            }
          : undefined,
        targets,
      } as PublishPostInput & { tiktok?: TikTokPublishInput | null });
      const skipNote = skippedAccounts.length > 0
        ? ` Skipped ${skippedAccounts.length} Instagram ${skippedAccounts.length === 1 ? 'account' : 'accounts'} (no media).`
        : '';

      // Scheduled path: server returns status='scheduled' + scheduledFor.
      if (result.status === 'scheduled' && result.scheduledFor) {
        const when = new Date(result.scheduledFor).toLocaleString(undefined, {
          weekday: 'short', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit',
        });
        // Patch 4.37.0: when promoting a draft, delete the old row.
        // Best-effort — if it fails, the draft just lingers and the
        // user can delete it from the Drafts page.
        if (editingDraftId) {
          try { await organicPosts.delete(editingDraftId); } catch { /* swallow */ }
        }
        // Patch 4.37.1: same logic for an idea-seeded compose.
        if (seededIdeaId) {
          try { await organicIdeas.delete(seededIdeaId); } catch { /* swallow */ }
        }
        addToast('success', `Scheduled for ${when}.${skipNote}`);
        if (onPublished) onPublished();
        setTimeout(() => onClose(), 800);
      } else if (result.status === 'published') {
        if (editingDraftId) {
          try { await organicPosts.delete(editingDraftId); } catch { /* swallow */ }
        }
        if (seededIdeaId) {
          try { await organicIdeas.delete(seededIdeaId); } catch { /* swallow */ }
        }
        addToast('success', `Published to ${result.succeeded} profile${result.succeeded === 1 ? '' : 's'}.${skipNote}`);
        if (onPublished) onPublished();
        setTimeout(() => onClose(), 800);
      } else if (result.status === 'partial') {
        // Partial — leave the draft in place so the user can retry the
        // failed targets without losing the WIP. Same for full-failure.
        addToast('error', `Partial: ${result.succeeded} succeeded, ${result.failed} failed.${skipNote}`);
        if (onPublished) onPublished();
      } else {
        addToast('error', `Publish failed for all ${result.failed ?? 0} target${result.failed === 1 ? '' : 's'}.${skipNote}`);
      }
    } catch (err) {
      addToast('error', err instanceof ApiError ? err.message : 'Publish failed');
    } finally {
      setPublishing(false);
    }
  };

  // ─── Save as draft (Patch 4.37.0) ─────────────────────────────────
  //
  // Drafts allow empty body, no media, and no targets. The composer
  // never blocks the user from saving. New drafts get POSTed with
  // asDraft=true; existing drafts get PATCHed.

  const handleSaveAsDraft = async () => {
    setSavingDraft(true);
    try {
      const skippedAccounts = mediaItems.length === 0
        ? selectedAccounts.filter((a) => a.platform === 'instagram')
        : [];
      const skippedIds = new Set(skippedAccounts.map((a) => a.id));
      const effectiveIds = selectedIds.filter((id) => !skippedIds.has(id));

      const targets = effectiveIds.map((id) => {
        const override = customizePerNetwork ? bodies[id] ?? '' : null;
        const tMedia = customizePerNetwork ? mediaByTarget[id] : undefined;
        const sharedSig = mediaItems.map((m) => m.upload.id).join(',');
        const tSig = (tMedia ?? []).map((m) => m.upload.id).join(',');
        const mediaOverride =
          customizePerNetwork && tMedia && tSig !== sharedSig
            ? tMedia.map((m) => ({ uploadId: m.upload.id, kind: m.kind }))
            : undefined;
        return {
          accountId: id,
          bodyOverride: override !== null && override !== sharedBody ? override : null,
          ...(mediaOverride ? { mediaItems: mediaOverride } : {}),
        };
      });
      const baseBody = customizePerNetwork && effectiveIds.length > 0
        ? bodies[effectiveIds[0]] ?? ''
        : sharedBody;

      const payload = {
        body: baseBody,
        mediaItems: mediaItems.map((m) => ({ uploadId: m.upload.id, kind: m.kind })),
        brandId: activeBrandId === 'all' ? null : activeBrandId,
        scheduledFor: null,
        firstComment: firstComment.trim() || null,
        collaborators: collaborators.length > 0 ? collaborators : null,
        coverUploadId: coverUploadId,
        topicTag: topicTag.trim() || null,
        documentTitle: documentTitle.trim() || null,
        replyChain: replyChain.length > 0
          ? replyChain.map((r) => ({
              body: r.body,
              mediaItems: r.mediaItems.map((m) => ({
                uploadId: m.upload.id,
                kind: m.kind,
              })),
            }))
          : undefined,
        targets,
        asDraft: true,
      };

      if (editingDraftId) {
        await organicPosts.update(editingDraftId, payload);
        addToast('success', 'Draft saved.');
      } else {
        const r = await organicPosts.publish(payload);
        // Now we're editing this draft — subsequent saves should PATCH
        // the same row instead of creating new ones.
        setEditingDraftId(r.postId);
        // Patch 4.37.1: if this compose was seeded from an idea, the
        // first successful draft-save converts it. Delete the idea so
        // it doesn't keep appearing in the Ideas list.
        if (seededIdeaId) {
          try { await organicIdeas.delete(seededIdeaId); } catch { /* swallow */ }
          setSeededIdeaId(null);
        }
        addToast('success', 'Draft saved.');
      }
      if (onPublished) onPublished();
    } catch (err) {
      addToast('error', err instanceof ApiError ? err.message : 'Failed to save draft');
    } finally {
      setSavingDraft(false);
    }
  };

  if (!open) return null;

  const filteredPickerAccounts = visibleAccounts.filter((a) => {
    if (!pickerQuery.trim()) return true;
    const q = pickerQuery.toLowerCase().trim();
    return (
      (a.meta.name ?? '').toLowerCase().includes(q) ||
      (a.meta.username ?? '').toLowerCase().includes(q)
    );
  });

  // Compose preview media (from local upload URLs — meta hasn't seen them yet)
  const previewMedia: PreviewMediaItem[] = activeMedia.map((m) => ({
    kind: m.kind,
    url: uploads.fileUrl(m.upload.id),
  }));

  const previewBody = previewChip
    ? customizePerNetwork
      ? bodies[previewChip.id] ?? ''
      : sharedBody
    : '';

  // Media block — rendered INSIDE the post card (after the toolbar), so the
  // upload zone visually belongs to the post itself (Buffer/Sprout pattern)
  // rather than floating below as a separate section. Defined once here and
  // reused in both the shared-body and per-profile cards.
  const mediaBlock = (
    <div className="border-t border-line px-4 py-3">
      {activeMedia.length > 0 ? (
        <div>
          {/* Thumb grid */}
          <div className="flex flex-wrap gap-2">
            {activeMedia.map((m, i) => {
              // Reorder only makes sense for an image carousel (>1).
              const reorderable = mediaIsImage && activeMedia.length > 1;
              return (
                <MediaThumb
                  key={m.upload.id}
                  item={m}
                  index={i}
                  onRemove={() => removeMediaItem(i)}
                  draggable={reorderable}
                  isDragging={dragThumbIdx === i}
                  isDropTarget={dragThumbIdx !== null && dragThumbIdx !== i}
                  onDragStart={() => setDragThumbIdx(i)}
                  onDragEnd={() => setDragThumbIdx(null)}
                  onDropItem={() => {
                    if (dragThumbIdx !== null) moveMediaItem(dragThumbIdx, i);
                    setDragThumbIdx(null);
                  }}
                />
              );
            })}
            {canAddMore && (
              <>
                <input
                  ref={addMoreInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => handleFiles(e.target.files)}
                  className="hidden"
                  id="composer-add-more"
                />
                <label
                  htmlFor="composer-add-more"
                  className={[
                    'w-20 h-20 border border-dashed border-line rounded-lg flex flex-col items-center justify-center gap-1 cursor-pointer transition-colors',
                    'text-ink-subtle hover:text-ink hover:border-ink-subtle',
                  ].join(' ')}
                >
                  {uploading ? (
                    <RefreshCw size={16} className="animate-spin" />
                  ) : (
                    <>
                      <Plus size={16} />
                      <span className="text-2xs font-medium">Add</span>
                    </>
                  )}
                </label>
              </>
            )}
          </div>
          <p className="text-2xs text-ink-subtle mt-2">
            {hasDocument
              ? 'PDF document. Publishes to LinkedIn only, one file per post.'
              : mediaIsVideo
              ? 'Single video. Will publish as a Reel on Instagram.'
              : `${mediaItems.length} image${mediaItems.length === 1 ? '' : 's'}${mediaItems.length > 1 ? ' — will publish as a carousel. Drag thumbnails to reorder.' : '.'}`}
          </p>

          {/* Document title — required for LinkedIn document posts. */}
          {hasDocument && (
            <div className="mt-3">
              <label className="block text-xs font-medium uppercase tracking-wider text-ink-subtle mb-1">
                Document title <span className="text-danger">*</span>
              </label>
              <input
                type="text"
                value={documentTitle}
                onChange={(e) => setDocumentTitle(e.target.value)}
                maxLength={100}
                placeholder="Title shown as the document's headline on LinkedIn"
                className={[
                  'w-full px-3 py-2 border rounded-sm text-sm text-ink bg-white focus:outline-none',
                  documentTitleMissing ? 'border-danger focus:border-danger' : 'border-line focus:border-accent',
                ].join(' ')}
              />
            </div>
          )}

          {/* Cover thumbnail picker — only meaningful for video. */}
          {mediaIsVideo && (
            <div className="mt-3 flex items-center gap-2.5 flex-wrap">
              {coverUploadId ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={uploads.fileUrl(coverUploadId)}
                    alt="Cover"
                    className="w-10 h-[60px] object-cover rounded border border-line bg-black"
                  />
                  <button
                    type="button"
                    onClick={() => setCoverPickerOpen(true)}
                    className="text-xs font-medium text-accent hover:underline"
                  >
                    Change cover
                  </button>
                  <span className="text-ink-subtle">·</span>
                  <button
                    type="button"
                    onClick={() => setCoverUploadId(null)}
                    className="text-xs text-ink-muted hover:text-danger"
                  >
                    Remove
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setCoverPickerOpen(true)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-dashed border-line text-xs text-ink-muted hover:text-ink hover:border-ink-subtle transition-colors"
                >
                  <Film size={12} />
                  Set custom cover
                </button>
              )}
              {/* If Threads is also in the target list, custom
                  covers don't propagate — Threads doesn't have
                  a thumbnail upload endpoint. */}
              {selectedHasThreads && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider bg-surface-alt text-ink-muted border border-line">
                  FB/IG only
                </span>
              )}
            </div>
          )}
        </div>
      ) : (
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*,application/pdf"
            multiple
            onChange={(e) => handleFiles(e.target.files)}
            className="hidden"
            id="composer-modal-image-upload"
          />
          {/* Larger, always-visible drop target (Sprout/Buffer pattern) —
              reads as part of the post card, not a small inline pill. */}
          <label
            htmlFor="composer-modal-image-upload"
            className="flex flex-col items-center justify-center gap-1.5 w-full h-28 border border-dashed border-line rounded-lg text-sm text-ink-muted hover:text-ink hover:border-ink-subtle hover:bg-surface-hover/40 cursor-pointer transition-colors"
          >
            {uploading ? (
              <>
                <RefreshCw size={18} className="animate-spin" />
                {uploadProgress
                  ? `Uploading ${uploadProgress.done + 1}/${uploadProgress.total} (${uploadProgress.pct}%)`
                  : 'Uploading…'}
              </>
            ) : (
              <>
                <ImageIcon size={20} />
                <span>Drag &amp; drop or <span className="text-accent font-medium">select a file</span></span>
              </>
            )}
          </label>
        </div>
      )}
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget && !publishing) onClose(); }}
    >
      {/* Toasts */}
      <div className="fixed top-5 right-5 z-[60] flex flex-col gap-2 w-80">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={[
              'flex items-start gap-3 px-4 py-3 rounded-lg shadow-lift border text-sm animate-slide-up',
              t.type === 'success' ? 'bg-white border-success/30 text-ink' : 'bg-white border-danger/30 text-ink',
            ].join(' ')}
          >
            {t.type === 'success' ? (
              <CheckCircle2 size={16} className="text-success shrink-0 mt-0.5" />
            ) : (
              <AlertCircle size={16} className="text-danger shrink-0 mt-0.5" />
            )}
            <span>{t.message}</span>
          </div>
        ))}
      </div>

      <div className="w-[min(1180px,96vw)] h-[min(92vh,860px)] bg-surface rounded-lg shadow-glass-lift border border-white/60 flex flex-col overflow-hidden animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line">
          <div>
            <h2 className="h-section text-ink leading-tight">New post</h2>
            <p className="text-xs text-ink-muted mt-0.5">Compose and publish to your social profiles.</p>
          </div>
          <button
            onClick={onClose}
            disabled={publishing}
            className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-hover transition-colors disabled:opacity-40"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Two-column body */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_440px] min-h-0">
          {/* ═══ Left: composer ═══════════════════════════════════════════ */}
          <div className="flex flex-col min-h-0 overflow-y-auto">
            {/* Profile chip row */}
            <div className="px-6 pt-5">
              <label className="text-xs font-medium uppercase tracking-wider text-ink-subtle">
                Publishing to
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {selectedAccounts.map((a) => {
                  const platform = PLATFORM_BY_ID[a.platform];
                  const Icon = platform?.icon ?? Facebook;
                  // In customize-per-network mode the "editor target" chip
                  // gets an accent ring so users know which body they're
                  // editing. In shared mode there's no such concept — all
                  // selected chips render identically.
                  const isEditorTarget = customizePerNetwork && activeChipId === a.id;
                  return (
                    <button
                      key={a.id}
                      onClick={() => {
                        if (customizePerNetwork) {
                          // Customize mode: clicking sets the editor target.
                          // Removal goes through the inline X.
                          setActiveChipId(a.id);
                        } else {
                          // Shared mode: chip click toggles selection.
                          handleRemoveProfile(a.id);
                        }
                      }}
                      className={[
                        'group flex items-center gap-2 pl-1 pr-1.5 py-1 rounded-full border transition-all',
                        isEditorTarget
                          ? 'bg-accent text-white border-accent shadow-card'
                          : 'bg-accent-subtle border-accent/30 text-accent hover:bg-accent/20',
                      ].join(' ')}
                      title={customizePerNetwork ? 'Click to edit this profile\'s copy' : 'Click to deselect'}
                    >
                      <div className="relative">
                        <div className="w-6 h-6 rounded-full overflow-hidden bg-white">
                          {a.meta.picture_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={a.meta.picture_url} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <span className="block w-full h-full flex items-center justify-center text-2xs font-semibold text-ink-muted">
                              {(a.meta.name ?? '?').charAt(0).toUpperCase()}
                            </span>
                          )}
                        </div>
                        <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-white flex items-center justify-center border border-white">
                          <Icon size={6.5} style={{ color: platform?.iconColor }} strokeWidth={3} />
                        </div>
                      </div>
                      <span className="text-xs font-medium truncate max-w-[120px]">
                        {a.meta.name ?? a.meta.username ?? PLATFORM_BY_ID[a.platform]?.label ?? a.externalId}
                      </span>
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); handleRemoveProfile(a.id); }}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleRemoveProfile(a.id); }}
                        className={[
                          'rounded-full p-0.5 transition-colors cursor-pointer',
                          isEditorTarget ? 'hover:bg-white/20' : 'hover:bg-accent/20',
                        ].join(' ')}
                        aria-label="Remove"
                      >
                        <X size={11} />
                      </span>
                    </button>
                  );
                })}

                {/* Add-more button */}
                <ProfilePickerPopover
                  open={pickerOpen}
                  setOpen={setPickerOpen}
                  query={pickerQuery}
                  setQuery={setPickerQuery}
                  visibleAccounts={filteredPickerAccounts}
                  loading={loading}
                  selectedIds={selectedIds}
                  onToggle={(id) => selectedIds.includes(id) ? handleRemoveProfile(id) : handleAddProfile(id)}
                />
              </div>

              {/* Customize-per-network toggle (only when 2+ profiles).
                  Sprout-style bordered button rather than a subtle text link. */}
              {selectedAccounts.length >= 2 && (
                <button
                  onClick={handleCustomizeToggle}
                  className={[
                    'mt-3 inline-flex items-center gap-2 text-sm font-medium px-3 py-2 rounded-lg border transition-colors',
                    customizePerNetwork
                      ? 'bg-accent-subtle text-accent border-accent/40'
                      : 'text-ink border-line hover:bg-surface-hover hover:border-ink-subtle',
                  ].join(' ')}
                >
                  <Layers size={15} />
                  {customizePerNetwork ? 'Customizing per network' : 'Customize post per network'}
                </button>
              )}
            </div>

            {/* Textarea(s) + toolbar */}
            <div className="px-6 mt-4 flex flex-col">
              {customizePerNetwork && activeChipId ? (
                <div className="flex flex-col bg-white rounded-lg border border-line">
                  <HighlightedTextarea
                    refCallback={(el) => {
                      if (el) perRefs.current.set(activeChipId, el);
                      else perRefs.current.delete(activeChipId);
                    }}
                    value={bodies[activeChipId] ?? ''}
                    onChange={(v) => setBodies((b) => ({ ...b, [activeChipId]: v }))}
                    placeholder="What's the message for this profile?"
                  />
                  <ComposerToolbar
                    body={bodies[activeChipId] ?? ''}
                    limit={
                      PLATFORM_BY_ID[
                        selectedAccounts.find((a) => a.id === activeChipId)?.platform ?? 'facebook_page'
                      ]?.charLimit ?? FALLBACK_LIMIT
                    }
                    onInsertEmoji={handleInsertEmoji}
                    onInsertText={handleInsertText}
                    brandHashtags={brandHashtagList}
                  />
                  {mediaBlock}
                </div>
              ) : (
                <div className="flex flex-col bg-white rounded-lg border border-line">
                  <HighlightedTextarea
                    refCallback={(el) => { sharedRef.current = el; }}
                    value={sharedBody}
                    onChange={setSharedBody}
                    placeholder="What would you like to share?"
                  />
                  <ComposerToolbar
                    body={counterBody}
                    limit={counterLimit}
                    onInsertEmoji={handleInsertEmoji}
                    onInsertText={handleInsertText}
                    brandHashtags={brandHashtagList}
                  />
                  {mediaBlock}
                </div>
              )}
            </div>

            {/* ─── Options: first comment + collaborators (IG-only) +
                Threads-only Topic Tag and Reply Chain composer.
                Location was in the toolbar pre-4.32.5; now removed. */}
            <div className="px-6 mt-5 mb-6 space-y-4">
              <ComposerOptions
                firstComment={firstComment}
                onFirstCommentChange={setFirstComment}
                collaborators={collaborators}
                onCollaboratorsChange={setCollaborators}
                showCollaborators={selectedHasInstagram}
                showFirstComment={selectedHasFacebook || selectedHasInstagram}
                showThreadsFields={selectedHasThreads}
                igOnlyBadge={selectedHasThreads && selectedHasInstagram}
                topicTag={topicTag}
                onTopicTagChange={setTopicTag}
                replyChain={replyChain}
                onReplyChainChange={setReplyChain}
                onReplyUploadError={(msg) => addToast('error', msg)}
              />

              {/* ─── TikTok options (Patch 4.43.1) ─── */}
              {selectedHasTikTok && (
                <TikTokOptions
                  loading={ttCreatorLoading}
                  error={ttCreatorError}
                  creatorInfo={ttCreatorInfo}
                  privacy={ttPrivacy}
                  onPrivacyChange={setTtPrivacy}
                  commercial={ttCommercial}
                  onCommercialChange={setTtCommercial}
                  yourBrand={ttYourBrand}
                  onYourBrandChange={setTtYourBrand}
                  brandedContent={ttBrandedContent}
                  onBrandedContentChange={setTtBrandedContent}
                  disableComment={ttDisableComment}
                  onDisableCommentChange={setTtDisableComment}
                  disableDuet={ttDisableDuet}
                  onDisableDuetChange={setTtDisableDuet}
                  disableStitch={ttDisableStitch}
                  onDisableStitchChange={setTtDisableStitch}
                  hasMedia={mediaItems.length > 0}
                />
              )}
            </div>
          </div>

          {/* ═══ Right: preview ═══════════════════════════════════════════ */}
          <div className="border-l border-line bg-gradient-to-br from-surface-alt/50 to-surface flex flex-col min-h-0">
            <div className="px-5 py-3 border-b border-line">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-medium uppercase tracking-wider text-ink-subtle">
                  Preview
                </div>
                {/* Avatar switcher — appears only when 2+ profiles are
                    selected. Clicking sets which profile drives the
                    preview pane (without changing selection). */}
                {selectedAccounts.length > 1 && (
                  <div className="flex items-center gap-1">
                    {selectedAccounts.map((a) => {
                      const platform = PLATFORM_BY_ID[a.platform];
                      const Icon = platform?.icon ?? Facebook;
                      const isActive = activeChipId === a.id;
                      return (
                        <button
                          key={a.id}
                          onClick={() => setActiveChipId(a.id)}
                          className={[
                            'relative w-7 h-7 rounded-full overflow-hidden transition-all',
                            isActive
                              ? 'ring-2 ring-accent ring-offset-1 ring-offset-surface'
                              : 'opacity-50 hover:opacity-100',
                          ].join(' ')}
                          title={a.meta.name ?? a.meta.username ?? PLATFORM_BY_ID[a.platform]?.label ?? a.externalId}
                        >
                          <div className="w-full h-full bg-surface-hover">
                            {a.meta.picture_url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={a.meta.picture_url} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <span className="block w-full h-full flex items-center justify-center text-2xs font-semibold text-ink-muted">
                                {(a.meta.name ?? '?').charAt(0).toUpperCase()}
                              </span>
                            )}
                          </div>
                          <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-white flex items-center justify-center border border-white">
                            <Icon size={6.5} style={{ color: platform?.iconColor }} strokeWidth={3} />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              {previewChip && (
                <div className="mt-1 text-xs text-ink-muted">
                  As it'll look on{' '}
                  <span className="font-medium text-ink">
                    {PLATFORM_BY_ID[previewChip.platform]?.label}
                  </span>
                </div>
              )}
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-6">
              {previewChip ? (
                previewMedia[0]?.kind === 'document' && previewChip.platform !== 'linkedin' ? (
                  <div className="flex flex-col items-center justify-center h-full text-center px-6 gap-2">
                    <FileText size={28} className="text-ink-subtle" />
                    <p className="text-sm text-ink-muted">
                      Please upload another file type to publish on{' '}
                      <span className="font-medium text-ink">
                        {PLATFORM_BY_ID[previewChip.platform]?.label ?? previewChip.platform}
                      </span>
                      .
                    </p>
                  </div>
                ) : previewChip.platform === 'instagram' ? (
                  <InstagramPreview
                    username={previewChip.meta.username ?? ''}
                    pictureUrl={previewChip.meta.picture_url}
                    body={previewBody}
                    media={previewMedia}
                  />
                ) : previewChip.platform === 'threads' ? (
                  <ThreadsPreview
                    username={previewChip.meta.username ?? ''}
                    pictureUrl={previewChip.meta.picture_url}
                    body={previewBody}
                    media={previewMedia}
                    topicTag={topicTag}
                    replyChain={replyChain.map((r) => ({
                      body: r.body,
                      media: r.mediaItems.map((m) => ({
                        kind: m.kind,
                        url: uploads.fileUrl(m.upload.id),
                      })),
                    }))}
                  />
                ) : previewChip.platform === 'tiktok' ? (
                  <TikTokPreview
                    username={previewChip.meta.username ?? previewChip.meta.name ?? ''}
                    pictureUrl={previewChip.meta.picture_url}
                    body={previewBody}
                    media={previewMedia}
                  />
                ) : previewChip.platform === 'linkedin' ? (
                  <div>
                    <LinkedInPreview
                      authorName={previewChip.meta.name ?? previewChip.meta.username ?? ''}
                      authorPictureUrl={previewChip.meta.picture_url}
                      subtitle={
                        (previewChip.meta as { kind?: string }).kind === 'organization'
                          ? 'Company Page'
                          : null
                      }
                      body={previewBody}
                      media={previewMedia}
                      documentTitle={documentTitle}
                    />
                    {previewMedia[0]?.kind === 'document' && docOnNonLinkedIn && (
                      <p className="mt-3 text-2xs text-danger flex items-center gap-1">
                        <AlertTriangle size={10} /> PDF posts can only go to LinkedIn. Remove the other networks.
                      </p>
                    )}
                  </div>
                ) : (
                  <FacebookPreview
                    pageName={previewChip.meta.name ?? ''}
                    pagePictureUrl={previewChip.meta.picture_url}
                    body={previewBody}
                    media={previewMedia}
                  />
                )
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-center px-6">
                  <p className="text-sm text-ink-muted">
                    Pick a profile to see how your post will look.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-line bg-surface-alt/30">
          <div className="text-xs text-ink-muted flex items-center gap-3">
            <div>
              {selectedIds.length === 0 ? (
                'Pick at least one profile.'
              ) : (
                <>Publishing to <span className="font-medium text-ink">{selectedIds.length}</span> profile{selectedIds.length === 1 ? '' : 's'}.</>
              )}
            </div>
            {scheduledFor && (
              <button
                onClick={() => setSchedulePickerOpen(true)}
                disabled={publishing}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-accent-subtle text-accent text-xs font-medium hover:bg-accent/20 transition-colors"
              >
                <CalendarClock size={11} />
                {new Date(scheduledFor).toLocaleString(undefined, {
                  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                })}
                <button
                  onClick={(e) => { e.stopPropagation(); setScheduledFor(null); }}
                  className="ml-0.5 p-0.5 rounded-full hover:bg-accent/20"
                  aria-label="Cancel schedule"
                >
                  <X size={10} />
                </button>
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={publishing || savingDraft}
              className="btn-ghost"
            >
              Cancel
            </button>
            {/* Save as draft (Patch 4.37.0) — secondary action.
                Always enabled when not already in flight; drafts allow
                empty content. */}
            <button
              onClick={handleSaveAsDraft}
              disabled={publishing || savingDraft}
              className="btn-secondary"
            >
              {savingDraft ? (
                <>
                  <RefreshCw size={14} className="animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <FileText size={14} />
                  {editingDraftId ? 'Save draft' : 'Save as draft'}
                </>
              )}
            </button>
            {/* Schedule button — opens the picker. Hidden when already scheduled
                (the chip in the left footer becomes the edit affordance). */}
            {!scheduledFor && (
              <button
                onClick={() => setSchedulePickerOpen(true)}
                disabled={!canPublish || publishing || savingDraft}
                className="btn-secondary"
              >
                <CalendarClock size={14} />
                Schedule
              </button>
            )}
            <button
              onClick={handlePublish}
              disabled={!canPublish || publishing || savingDraft}
              className="btn-primary"
            >
              {publishing ? (
                <>
                  <RefreshCw size={14} className="animate-spin" />
                  {scheduledFor ? 'Scheduling…' : 'Publishing…'}
                </>
              ) : scheduledFor ? (
                <>
                  <CalendarClock size={14} />
                  Schedule post
                </>
              ) : (
                <>
                  <Send size={14} />
                  Publish now
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Schedule picker — separate modal layered on top */}
      <SchedulePicker
        open={schedulePickerOpen}
        value={scheduledFor}
        onClose={() => setSchedulePickerOpen(false)}
        onConfirm={(iso) => {
          setScheduledFor(iso);
          setSchedulePickerOpen(false);
        }}
      />

      {/* Cover picker — only when open AND the post has a video to
          pick a frame from. Conditionally mounted so the <video>
          element doesn't preload until the user actually opens it. */}
      {coverPickerOpen && mediaIsVideo && mediaItems[0] && (
        <CoverPicker
          videoUploadId={mediaItems[0].upload.id}
          initialCoverUploadId={coverUploadId}
          onClose={() => setCoverPickerOpen(false)}
          onPick={(id) => setCoverUploadId(id)}
        />
      )}
    </div>
  );
}

// ─── Composer options panel ─────────────────────────────────────────────────

/**
 * Composer options that sit beneath the body+media: first comment
 * (always open) plus a collaborators row for IG.
 *
 * Location lives in the toolbar (next to hashtag), not here — matches
 * Sprout's pattern.
 */
function ComposerOptions({
  firstComment,
  onFirstCommentChange,
  collaborators,
  onCollaboratorsChange,
  showCollaborators,
  showFirstComment,
  showThreadsFields,
  igOnlyBadge,
  topicTag,
  onTopicTagChange,
  replyChain,
  onReplyChainChange,
  onReplyUploadError,
}: {
  firstComment: string;
  onFirstCommentChange: (v: string) => void;
  collaborators: string[];
  onCollaboratorsChange: (v: string[]) => void;
  /** True when at least one selected account is IG. FB doesn't expose
   *  the collab-invite API, so we hide the field entirely for FB-only
   *  selections. */
  showCollaborators: boolean;
  /** True when at least one selected account is FB or IG. Threads has
   *  reply chains instead of first comments, so we hide the field for
   *  Threads-only selections. */
  showFirstComment: boolean;
  /** True when at least one selected account is Threads. Toggles the
   *  TopicTagField and ReplyChainComposer visibility. */
  showThreadsFields: boolean;
  /** True when BOTH IG and Threads are selected together. Marks
   *  IG-only fields (collaborators) with a small "IG only" pill so the
   *  user understands those fields are dropped on the Threads side. */
  igOnlyBadge: boolean;
  topicTag: string;
  onTopicTagChange: (v: string) => void;
  replyChain: ReplyDraft[];
  onReplyChainChange: (v: ReplyDraft[]) => void;
  onReplyUploadError?: (msg: string) => void;
}) {
  return (
    <div className="space-y-4">
      {/* First comment — visible when at least one FB or IG target is
          selected. Hidden for Threads-only posts since Threads has
          reply chains instead. */}
      {showFirstComment && (
        <FirstCommentField value={firstComment} onChange={onFirstCommentChange} />
      )}

      {/* Collaborators (IG only). Inline 'IG only' pill when Threads is
          ALSO in the target set, so the user knows it's IG-side only. */}
      {showCollaborators && (
        <CollaboratorsField
          value={collaborators}
          onChange={onCollaboratorsChange}
          badge={igOnlyBadge ? <PlatformOnlyPill platform="instagram" /> : undefined}
        />
      )}

      {/* Threads-only: topic tag + reply chain. */}
      {showThreadsFields && (
        <div className="pt-4 border-t border-line space-y-4">
          <TopicTagField
            value={topicTag}
            onChange={onTopicTagChange}
            badge={<PlatformOnlyPill platform="threads" />}
          />
          <ReplyChainComposer
            replies={replyChain}
            onChange={onReplyChainChange}
            onUploadError={onReplyUploadError}
            badge={<PlatformOnlyPill platform="threads" />}
          />
        </div>
      )}
    </div>
  );
}

/** Small pill rendered inline-left of IG-only fields when Threads is
 *  ALSO in the target set. Pink to match Instagram brand. */
/**
 * PlatformOnlyPill — one badge for "this field only applies to platform X".
 * Replaces the old divergent IgOnlyPill (pink) / ThreadsOnlyPill (mono +
 * raw border-black). Single shape; the only thing that varies is the icon
 * and label. Uses a neutral token-based surface so all platform-only
 * badges read identically regardless of network.
 */
function PlatformOnlyPill({ platform }: { platform: 'instagram' | 'threads' }) {
  const cfg =
    platform === 'instagram'
      ? { Icon: Instagram, label: 'IG only' }
      : { Icon: AtSign, label: 'Threads only' };
  const { Icon } = cfg;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-surface-alt text-ink-muted border border-line">
      <Icon size={9} strokeWidth={2.5} />
      {cfg.label}
    </span>
  );
}

// ─── Collaborators field (IG only) ──────────────────────────────────────────

/**
 * Free-text chip input for IG collaborator usernames. Max 3 per Meta's
 * limit. We accept any string the user types and let IG validate at
 * publish time — verifying usernames client-side would require an
 * extra API round-trip per chip and IG only returns a yes/no, so the
 * UX cost outweighs the benefit.
 */
function CollaboratorsField({
  value,
  onChange,
  badge,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  /** Optional pill rendered inline-left of the input row. Used to mark
   *  this field as IG-only when Threads is also selected. */
  badge?: React.ReactNode;
}) {
  const MAX = 3;
  const [draft, setDraft] = useState('');

  const normalize = (raw: string): string | null => {
    let t = raw.trim();
    if (t.startsWith('@')) t = t.slice(1);
    // IG usernames: letters, digits, periods, underscores. Allow them
    // through; let the server / Meta reject genuinely bad input.
    t = t.toLowerCase().replace(/[^a-z0-9._]/g, '');
    if (!t) return null;
    return t.slice(0, 30); // IG username max
  };

  const commitDraft = () => {
    const n = normalize(draft);
    if (!n) { setDraft(''); return; }
    if (value.includes(n)) { setDraft(''); return; }
    if (value.length >= MAX) { setDraft(''); return; }
    onChange([...value, n]);
    setDraft('');
  };

  const atCap = value.length >= MAX;

  return (
    <ComposerSection
      icon={Users}
      label="Collaborators"
      counter={`${value.length} / ${MAX}`}
      bodyPadding={false}
    >
      <div className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {badge && <span className="shrink-0">{badge}</span>}
          {value.map((u, i) => (
            <span
              key={u}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-accent-subtle text-accent border border-accent/15"
            >
              @{u}
              <button
                onClick={() => onChange(value.filter((_, idx) => idx !== i))}
                className="p-0.5 rounded-full hover:bg-accent/20"
                aria-label={`Remove @${u}`}
              >
                <X size={10} />
              </button>
            </span>
          ))}
          {!atCap && (
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
                  e.preventDefault();
                  commitDraft();
                } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
                  onChange(value.slice(0, -1));
                }
              }}
              onBlur={commitDraft}
              placeholder={value.length === 0 ? '@username and press Enter' : ''}
              className="flex-1 min-w-[140px] px-1 py-0.5 text-sm bg-transparent focus:outline-none placeholder:text-ink-subtle"
            />
          )}
        </div>
        <p className="text-2xs text-ink-subtle mt-2">
          Each collaborator gets an invite. The post appears on their profile too once they accept. Max 3.
        </p>
      </div>
    </ComposerSection>
  );
}

// ─── Media thumb ─────────────────────────────────────────────────────────────

function MediaThumb({
  item,
  index,
  onRemove,
  draggable = false,
  isDragging = false,
  isDropTarget = false,
  onDragStart,
  onDragEnd,
  onDropItem,
}: {
  item: MediaItem;
  index: number;
  onRemove: () => void;
  draggable?: boolean;
  isDragging?: boolean;
  isDropTarget?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDropItem?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      draggable={draggable}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart?.(); }}
      onDragEnd={() => { setHovered(false); onDragEnd?.(); }}
      onDragOver={(e) => { if (isDropTarget) { e.preventDefault(); setHovered(true); } }}
      onDragLeave={() => setHovered(false)}
      onDrop={(e) => { e.preventDefault(); setHovered(false); onDropItem?.(); }}
      className={[
        'relative group w-20 h-20 rounded-lg overflow-hidden border bg-surface transition-all',
        draggable ? 'cursor-grab active:cursor-grabbing' : '',
        isDragging ? 'opacity-40' : '',
        hovered && isDropTarget ? 'border-accent ring-2 ring-accent/40' : 'border-line',
      ].join(' ')}
    >
      {item.kind === 'video' ? (
        <VideoPlayer src={uploads.fileUrl(item.upload.id)} thumbnailOnly />
      ) : item.kind === 'document' ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-surface-alt text-ink-subtle pointer-events-none">
          <FileText size={26} />
          <span className="text-[10px] font-medium uppercase tracking-wider">PDF</span>
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={uploads.fileUrl(item.upload.id)} alt="" className="w-full h-full object-cover pointer-events-none" />
      )}
      {/* Order badge */}
      <div className="absolute bottom-1 left-1 bg-black/60 text-white text-2xs font-medium px-1.5 py-0.5 rounded pointer-events-none">
        {index + 1}
      </div>
      <button
        onClick={onRemove}
        className="absolute top-1 right-1 p-1 rounded-full bg-black/60 hover:bg-black/80 text-white opacity-0 group-hover:opacity-100 transition-opacity"
        title="Remove"
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}

// ─── Profile picker popover ──────────────────────────────────────────────────

function ProfilePickerPopover({
  open,
  setOpen,
  query,
  setQuery,
  visibleAccounts,
  loading,
  selectedIds,
  onToggle,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  query: string;
  setQuery: (v: string) => void;
  visibleAccounts: OrganicAccount[];
  loading: boolean;
  selectedIds: string[];
  onToggle: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open, setOpen]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-dashed border-line text-ink-muted hover:text-ink hover:border-ink-subtle transition-colors text-xs font-medium"
      >
        <Plus size={12} />
        Add profile
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-2 w-80 bg-white border border-line rounded-lg shadow-lift z-30 overflow-hidden">
          <div className="relative p-2 border-b border-line">
            <Search
              size={13}
              className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-subtle pointer-events-none"
            />
            <input
              autoFocus
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search profiles…"
              className="w-full pl-7 pr-2 py-1.5 text-sm bg-surface-alt rounded-lg border border-line focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/15 transition-colors"
            />
          </div>
          <div className="max-h-[300px] overflow-y-auto">
            {loading ? (
              <div className="px-4 py-6 text-center text-sm text-ink-subtle">Loading…</div>
            ) : visibleAccounts.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-ink-muted">
                {query ? `No matches for "${query}"` : 'No profiles in the active brand.'}
              </div>
            ) : (
              <ul>
                {visibleAccounts.map((a) => {
                  const platform = PLATFORM_BY_ID[a.platform];
                  const PlatformIcon = platform?.icon ?? Facebook;
                  const isSelected = selectedIds.includes(a.id);
                  return (
                    <li key={a.id}>
                      <button
                        onClick={() => onToggle(a.id)}
                        className="flex items-center gap-2.5 w-full text-left px-3 py-2 hover:bg-surface-hover transition-colors"
                      >
                        <div className="relative shrink-0">
                          <div className="w-7 h-7 rounded-full overflow-hidden bg-surface-hover">
                            {a.meta.picture_url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={a.meta.picture_url} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <span className="block w-full h-full flex items-center justify-center text-2xs font-semibold text-ink-muted">
                                {(a.meta.name ?? '?').charAt(0).toUpperCase()}
                              </span>
                            )}
                          </div>
                          <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-white flex items-center justify-center border border-white">
                            <PlatformIcon size={8} style={{ color: platform?.iconColor }} strokeWidth={2.5} />
                          </div>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-ink truncate">
                            {a.meta.name ?? a.meta.username ?? PLATFORM_BY_ID[a.platform]?.label ?? a.externalId}
                          </div>
                          {a.meta.username && (
                            <div className="text-2xs text-ink-subtle truncate">@{a.meta.username}</div>
                          )}
                        </div>
                        {isSelected && (
                          <Check size={14} className="text-accent shrink-0" />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── TikTok options panel (Patch 4.43.1) ─────────────────────────────
//
// Renders when a TikTok target is selected. Shows the creator's
// name/avatar (TikTok's mandatory pre-post disclosure UX), a privacy
// dropdown limited to the levels TikTok allows for this creator, the
// commercial-content disclosure toggles, and interaction toggles.

const TT_PRIVACY_LABELS: Record<string, string> = {
  PUBLIC_TO_EVERYONE: 'Everyone',
  MUTUAL_FOLLOW_FRIENDS: 'Friends (mutual follows)',
  FOLLOWER_OF_CREATOR: 'Followers',
  SELF_ONLY: 'Only me (private)',
};

function TikTokOptions({
  loading,
  error,
  creatorInfo,
  privacy,
  onPrivacyChange,
  commercial,
  onCommercialChange,
  yourBrand,
  onYourBrandChange,
  brandedContent,
  onBrandedContentChange,
  disableComment,
  onDisableCommentChange,
  disableDuet,
  onDisableDuetChange,
  disableStitch,
  onDisableStitchChange,
  hasMedia,
}: {
  loading: boolean;
  error: string | null;
  creatorInfo: {
    creatorNickname: string | null;
    creatorUsername: string | null;
    creatorAvatarUrl: string | null;
    privacyOptions: string[];
    commentDisabled: boolean;
    duetDisabled: boolean;
    stitchDisabled: boolean;
    maxVideoSeconds: number | null;
  } | null;
  privacy: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY';
  onPrivacyChange: (v: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY') => void;
  commercial: boolean;
  onCommercialChange: (v: boolean) => void;
  yourBrand: boolean;
  onYourBrandChange: (v: boolean) => void;
  brandedContent: boolean;
  onBrandedContentChange: (v: boolean) => void;
  disableComment: boolean;
  onDisableCommentChange: (v: boolean) => void;
  disableDuet: boolean;
  onDisableDuetChange: (v: boolean) => void;
  disableStitch: boolean;
  onDisableStitchChange: (v: boolean) => void;
  hasMedia: boolean;
}) {
  const privacyOpts = creatorInfo?.privacyOptions?.length
    ? creatorInfo.privacyOptions
    : ['SELF_ONLY'];

  return (
    <ComposerSection icon={Music2} label="TikTok options">
      <div className="space-y-4">
        {loading && (
          <div className="text-xs text-ink-muted flex items-center gap-2">
            <RefreshCw size={12} className="animate-spin" /> Loading TikTok settings…
          </div>
        )}
        {error && (
          <div className="text-xs text-danger flex items-start gap-2">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* All toggles in one row: disclosure + interaction controls */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
            <input
              type="checkbox"
              checked={commercial}
              onChange={(e) => onCommercialChange(e.target.checked)}
            />
            Disclose commercial content
          </label>
          <label className="flex items-center gap-1.5 text-sm text-ink cursor-pointer">
            <input type="checkbox" checked={disableComment} onChange={(e) => onDisableCommentChange(e.target.checked)} disabled={creatorInfo?.commentDisabled} />
            No comments
          </label>
          <label className="flex items-center gap-1.5 text-sm text-ink cursor-pointer">
            <input type="checkbox" checked={disableDuet} onChange={(e) => onDisableDuetChange(e.target.checked)} disabled={creatorInfo?.duetDisabled} />
            No duet
          </label>
          <label className="flex items-center gap-1.5 text-sm text-ink cursor-pointer">
            <input type="checkbox" checked={disableStitch} onChange={(e) => onDisableStitchChange(e.target.checked)} disabled={creatorInfo?.stitchDisabled} />
            No stitch
          </label>
        </div>

        {/* Commercial sub-options only when disclosing */}
        {commercial && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
              <input type="checkbox" checked={yourBrand} onChange={(e) => onYourBrandChange(e.target.checked)} />
              Your own brand
            </label>
            <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
              <input type="checkbox" checked={brandedContent} onChange={(e) => onBrandedContentChange(e.target.checked)} />
              Branded content (paid partnership)
            </label>
            {!yourBrand && !brandedContent && (
              <p className="text-2xs text-warning flex items-center gap-1">
                <AlertTriangle size={10} /> Pick at least one when disclosing.
              </p>
            )}
          </div>
        )}

        {!hasMedia && (
          <p className="text-2xs text-warning flex items-center gap-1">
            <AlertTriangle size={10} /> TikTok needs a video or at least one image.
          </p>
        )}
        <p className="text-2xs text-ink-subtle leading-relaxed">
          Until your TikTok app passes review, posts publish privately regardless of any privacy setting.
        </p>
      </div>
    </ComposerSection>
  );
}
