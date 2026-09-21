# Zaokit providers deployment — 2026-09-21

Deployed to https://edu.zaokit.app from commit `81bb8a92`.

- Added Zaokit to language, image, video, TTS, ASR, PDF, and web search settings, plus the Zaokit AI Token Plan preset.
- Default gateway: `https://api.zaokit.com/v1`; uses the supplied colored Z mark.
- 308 targeted checks passed; full TypeScript and 12-language key alignment checks passed.
- Isolated production build passed using Node 22.22.1. Runtime dependencies match the prior production image.
- Included every `.next/server` file in the package to preserve the account-page packaging fix. Verified the archive contains all server outputs, and excludes private environment files.
- Candidate startup, health, login, authentication configuration, and logo checks passed before switching.
- Production image: `zaokit-edu:20260921-providers-81bb8a92`; previous image retained: `zaokit-edu:20260921-account-fix`.
- Build ID: `1wgHtYZW4Y6pI4kNLvwQv`.
- Runtime archive SHA256: `df017e129ffc829f622c1d75e0acbf370a5b8eb5086eed4cef28bacbbaa7498c`.
- Production health and logo requests passed; public logo SHA256 matches the source: `5d9d0d4b7a289d91c1194f225e5fe5e9cf621ac9f884d240ca8afcc14638b237`.
- Logged-in browser verified all seven provider entries, default LLM request address, Token Plan page, and account page after deployment.
- Original database and data volume retained. Before/after: 4 classrooms, 52 scenes, content digest `0d709b22053e54899363d49d4fb4e34b`.
- Database dump, previous compose configuration, deployment script, and verification result are in `/opt/openmaic/backups/20260921-zaokit-providers/`.

## Verification boundary

Provider request/response handling was tested with controlled responses. No valid Zaokit account key was supplied for live generation tests. In particular, video, document input, and web search use compatible gateway protocols; availability depends on gateway support and account entitlements. The settings page explicitly describes this limitation. Deployment does not claim that every listed model is available to every plan.

## GPT-5.4 retirement follow-up

- Commit `dbefe6cc` removes the GPT-5.4 base, Mini, Nano, and Pro entries. Saved provider catalogs, fetched lists, and stale selected models are filtered; the existing GPT-5.6 Terra default is preferred for old selections.
- Local and production `OPENAI_MODELS` lists were cleaned, without changing keys or unrelated routes.
- 226 targeted checks and the production build passed. The logged-in production browser verified that neither the selected model nor provider list contains GPT-5.4, and that GPT-5.6 Terra is selected.
- Deployed image `zaokit-edu:20260921-retire-gpt54` is healthy. The previous image and configuration are retained; 4 classrooms and 52 scenes remain unchanged, with the same content digest as above.
- Deployment records and private configuration backup: `/opt/openmaic/backups/20260921-retire-gpt54/`.
- Disk-pressure recovery removed generated unpacked release inputs and 2.972 GB of unused build cache. Database, data volumes, runtime archives, and rollback images were retained. Available disk space after cleanup was 1.4 GB.

## Zaokit priority follow-up

- Commit `6b3ab244` pins Zaokit first independently of persisted provider order. Applies to all seven settings lists, Token Plan, and provider/model selectors. Existing active selections and credentials are preserved.
- 96 settings/config checks, TypeScript, and the production build passed. Local and logged-in production browsers verified Zaokit as the first item in all eight settings sections.
- Production image `zaokit-edu:20260921-priority` is healthy; previous image `zaokit-edu:20260921-retire-gpt54` retained. Classroom counts and content digest remain unchanged.
- Deployment record: `/opt/openmaic/backups/20260921-priority/`.
- To limit deployment disk usage, the package was streamed into an isolated image preparation container without an extracted server-side staging directory. Unused build cache was reclaimed. The two prior server-side runtime archive copies were removed after confirming local copies; database/configuration backups and rollback images remain. Disk available after cleanup: 1.6 GB.
