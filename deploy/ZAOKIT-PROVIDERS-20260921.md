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
