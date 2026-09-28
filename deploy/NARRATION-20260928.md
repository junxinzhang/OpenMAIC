# Classroom narration work — 2026-09-28

Classroom: `GW_5fxujQX`.

- Added the owner-only “补齐课堂配音” control in `5570e9c2`. It uses the browser's saved speech settings, fills missing speech audio, and persists each completed line. Existing audio is preserved. Leaving the classroom can interrupt this browser-side operation; restarting resumes the missing lines.
- The course has 78 speech actions. Before this run it had five legacy `tts_s1_*` references, all on the first scene.
- Actual Qwen requests used `qwen-tts`, `qwen3-tts-flash`, and `Cherry`. At the pause checkpoint, 41 newly synthesized clips were stored as allocated server assets; 32 speech actions remained unvoiced.
- Checked one downloaded server audio sample with FFprobe: PCM 16-bit mono, 24 kHz, 13.84 seconds. The synthesized WAV uses an unknown-length stream header; the existing duration parser correctly uses the real payload length.
- The user's Chrome Application panel confirmed that the pre-account `MAIC-Database` still holds 101 audio entries overall, exactly five belonging to this course. The scoped account database contained the newly generated clips. No old audio records were deleted or re-synthesized.
- `9a2cd0d6` adds owner-gated recovery from the pre-account audio cache. It only copies clips whose course ID and recorded text match, then uses the existing asset adoption/write-back path. It preserves the original cached record and makes no TTS request. Recovery tests plus adoption tests: 40 passed. The first narration checks: 57 passed. Production builds passed.
- Deployed image: `zaokit-edu:20260928-narration-cache`; previous image retained: `zaokit-edu:20260928-narration`. Startup checks passed. Actual recovery of the five old clips still awaits loading the updated classroom in that Chrome profile; this is not yet a full-course completion claim.
- Original classroom backup and first deployment record: `/opt/openmaic/backups/20260928-narration/`. Cache-recovery deployment record: `/opt/openmaic/backups/20260928-narration-cache/`.

## Completion verification

The expanded classroom now has 26 content pages and 96 speech segments. All 96 segments resolve to stored audio assets with non-empty, complete bytes. The six new pages (1, 2, 4, 9, 19, 26) each have all three clips, 18/18 in total. Downloaded all 18 new clips and checked decoding/duration with FFprobe; durations match stored metadata and total 210.24 seconds. Compared the final scene data with the post-content-edit snapshot: slide content, narration text, order, and scene/action identities are unchanged; only audio fields were filled. No speech remains audio-invalidated.

Chrome displayed the completed generation control and the new closing page was actually played. The player was returned from 2× to 1× and verified in the final screenshot. Evidence files: `/tmp/edu-course-review/new-audio/verification.json`, `/tmp/edu-course-review/scenes.audio-complete.json`, and `/tmp/edu-course-review/narration-complete.png`. Earlier incomplete counts in this record are historical checkpoints, not the current state.
