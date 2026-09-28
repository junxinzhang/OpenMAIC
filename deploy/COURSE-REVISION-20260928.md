# Junior-high classroom content revision — 2026-09-28

Target: `GW_5fxujQX`.

Added six native, editable classroom slides using the original 1000 × 562.5 dark layout: learning goals, generative-AI capabilities/limits, a school-club prompt example, a worked fact-check example, privacy boundaries, and a closing evidence-of-learning card. Each has three short narration segments. Interactive activities are explicitly described as classroom simulations on the new introduction page.

The classroom now has 26 content pages, plus the virtual completion page. New pages occur at 1, 2, 4, 9, 19, and 26. The original 20 scene IDs, content objects, narration text, and audio references were compared after the write and preserved exactly. Outlines and page order were updated atomically through the normal PostgreSQL DocumentStore with asset-reference tracking and a concurrent-change check. Native slide validation and local layout checks passed. The live post-edit visual check remains pending because the Mac locked during the task.

Backup: `/opt/openmaic/backups/20260928-narration-cache/classroom.before-content-edit.json`; a copy also exists in the persistent data volume at `/app/data/course-revisions/20260928/GW_5fxujQX.before.json`. The prepared six-page payload and update script are in the same host backup directory.

Narration status: the five pre-account first-page clips have now been recovered into allocated server assets; 41 newly generated Qwen clips remain. Of 96 total speech segments after these additions, 46 have audio and 50 still need synthesis (32 pre-existing gaps plus 18 new segments). The user's description of the wrong sound still needs a specific symptom or page; do not assume that successful synthesis alone resolves that complaint. A playback-speed inspection was interrupted by the Mac lock after clicking the cycling speed control; re-check and restore/confirm normal 1× playback before further testing. No new synthesis or voice replacement was performed during this content revision.

## Narration completed

All 96 narration segments are now saved and backed by complete audio files, including all 18 segments on the six added pages. The original content, text and order were preserved. The new closing page was played in Chrome; normal 1× speed was restored and visually confirmed. See `NARRATION-20260928.md` for the completed verification record.

## Bright classroom redesign

Applied the user's chosen bright, playful style with a small amount of cartoon illustration to the same production classroom. Rebuilt the 12 native slides with cream backgrounds, purple/teal/amber accents, larger headings, short instructions, and editable robot, magnifier and book illustrations. Rethemed DOM panels on 14 interactive pages and added plain-language activity guides; the original game scripts remain byte-for-byte unchanged. Canvas game interiors keep their original drawings. Updated corresponding outline titles and native spotlight targets.

Verification: all 12 slide schemas passed; local slide text bounds were checked; all 14 activities were visually inspected and started or advanced in the same sandbox/storage-shim setup as the classroom. Corrected low-contrast text discovered in the dark-theme activities. Production content was compared against all 26 planned pages after saving through PgDocumentStore with a concurrent-change guard. All 96 speech records, text and audio references remained identical. Database verification found 96/96 complete nonempty audio files, including all 18 on added pages. Live classroom reload showed the new cover and activity guides; the live prompt-building activity started successfully, and lesson playback advanced without console errors. No audio regeneration, voice replacement, app deployment, or credential change was needed.

A fresh full-document backup was saved before the write under `/app/data/course-revisions/20260928-bright/` in the persistent volume. Prepared before/after payloads and the update helper are under the host's existing protected course backup directory.
