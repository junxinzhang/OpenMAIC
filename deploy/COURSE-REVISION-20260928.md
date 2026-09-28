# Junior-high classroom content revision — 2026-09-28

Target: `GW_5fxujQX`.

Added six native, editable classroom slides using the original 1000 × 562.5 dark layout: learning goals, generative-AI capabilities/limits, a school-club prompt example, a worked fact-check example, privacy boundaries, and a closing evidence-of-learning card. Each has three short narration segments. Interactive activities are explicitly described as classroom simulations on the new introduction page.

The classroom now has 26 content pages, plus the virtual completion page. New pages occur at 1, 2, 4, 9, 19, and 26. The original 20 scene IDs, content objects, narration text, and audio references were compared after the write and preserved exactly. Outlines and page order were updated atomically through the normal PostgreSQL DocumentStore with asset-reference tracking and a concurrent-change check. Native slide validation and local layout checks passed. The live post-edit visual check remains pending because the Mac locked during the task.

Backup: `/opt/openmaic/backups/20260928-narration-cache/classroom.before-content-edit.json`; a copy also exists in the persistent data volume at `/app/data/course-revisions/20260928/GW_5fxujQX.before.json`. The prepared six-page payload and update script are in the same host backup directory.

Narration status: the five pre-account first-page clips have now been recovered into allocated server assets; 41 newly generated Qwen clips remain. Of 96 total speech segments after these additions, 46 have audio and 50 still need synthesis (32 pre-existing gaps plus 18 new segments). The user's description of the wrong sound still needs a specific symptom or page; do not assume that successful synthesis alone resolves that complaint. A playback-speed inspection was interrupted by the Mac lock after clicking the cycling speed control; re-check and restore/confirm normal 1× playback before further testing. No new synthesis or voice replacement was performed during this content revision.
