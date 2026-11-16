# Private client photos

Team members can open **Clients → client record → Private photos**. Reading requires client-directory access; adding, editing and removing require client-editing permission. Customer accounts and anonymous visitors cannot read these images, including by copying an image URL. The public portfolio is a separate, unfinished feature; this gallery never publishes an image.

## Add and review

Choose a JPEG, PNG or WebP file up to 15 MiB. The browser creates a still-image preview, reduces large photos to at most 1,024 pixels per side and preserves smaller dimensions. Enter a description (1–300 characters), optionally choose the date taken, then explicitly confirm permission to store it in the private record. Selecting another file clears that confirmation. The server records the uploader and `private-client-photo-v1` permission revision. Custom versioned intake forms/waivers remain separate work.

The server independently checks the signature and decodes the submitted raster, caps the input at 512 KiB/16 million pixels, corrects orientation, strips EXIF/location and other metadata, and writes fresh JPEG pixels. It accepts no SVG or arbitrary document upload. Stored JPEGs are at most 256 KiB. Processing is limited to two concurrent jobs per API process, with bounded decoding/output work. File names and original camera files are not retained. The normalization behavior follows the [sharp output API](https://sharp.pixelplumbing.com/api-output/) and is verified with synthetic metadata-bearing fixtures.

Open a thumbnail to review or edit its description/date. Concurrent changes require an explicit reload; the current draft is retained. A background gallery-read failure also preserves an open draft. After an uncertain upload response, retry the unchanged form to recover the original upload identifier. The identifier remains in that open form; reloading/closing the draft does not preserve it. Check the gallery before starting another upload after an uncertain response.

## Capacity and removal

There are 20 active photos per client and 2,000 per salon. Upload transactions serialize capacity checks, so concurrent requests cannot occupy the last space twice. These limits bound active JPEG payloads to 500 MiB, plus database indexes, metadata, WAL and backup storage. Remove unused images before adding more when capacity is reached.

Removal requires confirmation and the revision last reviewed. It clears the binary image, private caption and taken date from the active row, leaving minimal revision/idempotency/audit metadata. Repeating the same removal is safe; retrying the old upload identifier cannot restore a removed image. Existing backups retain their contents according to the deployment's backup retention. Soft-deleting the entire client hides their gallery; it is not the per-photo erasure action.

## Storage and operations

Normalized pixels live in PostgreSQL `bytea` rows, so the existing database backup/restore covers this single-location gallery without a separate object-storage account or writable image volume. Restrict those backups as you do client records. Images and metadata responses require current server authorization and use private `no-store` cache controls. Raw pixels are excluded from list DTOs and audit entries; images are not added to the desktop/offline sync payload. Native gallery presentation remains unfinished.

The API production image includes pinned sharp 0.35.5 and its prebuilt runtime dependencies. The image builds using the existing Dockerfile, runs read-only, and passed the image/integration cases on pinned Bun 1.4.4 against isolated local test infrastructure. No cloud provider, actual photo, bank operation or message delivery is involved in verification.

## Verification

Nine focused API/image tests cover normalized orientation and stripped metadata, supported raster formats, discarded trailing content, authorization/client scope, invalid/pixel-bounded inputs, concurrent retry and final-slot capacity, salon capacity, revision conflicts and confirmed erasure. Client-directory regressions pass as well. Component tests cover permission gating, uncertain uploads, background-read failure, stale drafts, removal and capacity messages. The four real photo browser workflows verify still-image sizing, retained retry identity, private image reads, explicit stale-edit review, Spanish layouts, erasure, axe and horizontal overflow across mobile/desktop and light/dark; the four CSV workflows run alongside them.

A browser regression also reproduced notifications intercepting sheet actions for several seconds. The shared sheet footer now reserves measured space for notifications, with nested/resize/unmount handling and late-observer cleanup coverage. Browser checks verify the action remains the live hit target while the success notification is still visible.

Final integration verification passed 936 API, 704 web, 140 contract and 47 database tests, twelve real browser cases (eight CRM plus four booking regressions), forced type checks and repository lint. The final production image passed all nine image/API cases on Bun 1.4.4. Subsequent intake-form development is tracked separately and is not included in these counts.
