-- Replace existing unwatermarked derivatives. The worker writes watermarked
-- previews and thumbnails while original files remain unchanged.
update public.photos
set processing_status = 'pending',
    processing_started_at = null,
    processing_available_at = null,
    processing_token = null,
    processing_attempts = 0,
    processed_at = null,
    width = null,
    height = null
where processing_status = 'ready' and deletion_requested_at is null;
