-- 035_linkedin_documents.sql
-- LinkedIn document posts: a PDF is uploaded and published as a LinkedIn
-- "document" post. This requires the upload + post_media kind enums to
-- accept 'document' in addition to 'image' / 'video'.
--
-- We also store a document title on the post target, because LinkedIn's
-- document post REQUIRES a title (it shows as the document's headline).

-- 1) uploads.kind  ('image','video') -> add 'document'
ALTER TABLE uploads DROP CONSTRAINT IF EXISTS uploads_kind_check;
ALTER TABLE uploads ADD CONSTRAINT uploads_kind_check
  CHECK (kind IN ('image','video','document'));

-- 2) organic_post_media.kind  ('image','video') -> add 'document'
ALTER TABLE organic_post_media DROP CONSTRAINT IF EXISTS post_media_kind_check;
ALTER TABLE organic_post_media ADD CONSTRAINT post_media_kind_check
  CHECK (kind IN ('image','video','document'));

-- 3) Document title for LinkedIn document posts. Lives on the organic post
--    (one document per post by product rule). NULL for non-document posts.
ALTER TABLE organic_posts ADD COLUMN IF NOT EXISTS document_title TEXT;
