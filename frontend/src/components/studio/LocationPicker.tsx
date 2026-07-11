/**
 * LocationPicker — REMOVED in patch 4.32.5.
 *
 * Location tagging was killed because Meta's place-search endpoint
 * required app-review-only permissions we don't have. See the
 * VASS-HANDOFF notes for the full diagnostic.
 *
 * This file is intentionally an inert stub: it exists so the patch
 * installer (which only copies, never deletes) can overwrite the
 * old broken version that referenced a now-removed export. Nothing
 * in the codebase imports this stub. Patch 4.34+ uses the new
 * DELETE.txt mechanism to actually remove the file.
 */

export {};
