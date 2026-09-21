# Cowork-style accounts and credits — 2026-09-21

Deployed at https://edu.zaokit.app/account.
Reference: `/Users/jason/workspace/zaokit-cowork`, branch `codex/cowork-google-main`, commit `850dfbf8`.

## Delivered policy

- One 200-credit Auto trial per verified Edu account, isolated by billing environment.
- Plus: USD 20/month, 5,000 credits. Pro: USD 100/month, 25,000 credits. Max: USD 200/month, 100,000 credits.
- Text generation reserves up to 500 credits (or remaining allowance), then charges `ceil((input_tokens + 4 * output_tokens) / 1000)`, capped by its reservation. Known zero differs from unknown usage. Unused reservation is returned; known failures release it; interrupted tasks charge confirmed usage. Unknown usage remains pending.
- Edu's existing accounting boundaries are retained: a background classroom/Agent run aggregates its model calls; standalone generation requests settle independently. Background task start/concurrency policies follow Cowork. Configuration/connection checks are authenticated and rate limited but do not reserve credits.
- Edu-specific image/video/TTS operations retain explicit per-operation pricing (defaults: 5/image, 20/video, 1/TTS). Media inside a metered classroom task is included once in that task's settlement. These media rates are not represented as Cowork's text-token formula.
- Paid periods reset rather than accumulate. Upgrades require both higher price and more credits, charge the full new monthly price, start a new period, replace prior remaining allowance, and remove scheduled cancellation. Failed payment preserves the original plan. Downgrades require the existing subscription to end.
- Purchased price/credit contracts remain immutable; delayed invoices use the price they actually purchased. Test balances are never consumed in live mode. Edu users, customers, invoices and credits remain independent from Cowork.
- Account UI has Billing, Usage and Profile views; plan comparison and upgrade confirmation; current-period balance versus historical task/invoice records; explicit live USD recurring-payment wording.

## Verification

- Related regression: 2,146 passed, 29 existing skips. After merging the latest provider/retired-model changes: 38 targeted checks passed. A further 5 guard checks passed, including free configuration probes. These groups overlap.
- Complete TypeScript and production build passed. Billing/account lint passed.
- Real sandbox email sign-in granted 200 once. A real classroom used 18,625 input and 2,882 output tokens: 31 credits charged, 169 remaining, zero reserved.
- Stripe sandbox: Plus paid and granted 5,000 once, duplicate notification ignored; Pro upgrade replaced it with 25,000; period-end cancellation retained the allowance; HTTP Max upgrade granted 100,000 and cleared cancellation. Three real sandbox invoices, no real-money payment.
- Live: three dedicated Edu products/prices, portal and webhook created in the existing approved merchant account. A real Stripe product update `evt_1UI361Rj8zmYIEzsGE1jP5ct` reached the live endpoint and passed signature verification. Temporary probe event subscription and metadata were restored.
- Browser live Checkout showed Zaokit AI Edu Plus, USD 20/month and 5,000 credits. No payment details were submitted. The exact unpaid validation checkout was expired; no subscription or paid invoice was created.
- Live authenticated account page, 200-credit trial, catalog, unauthenticated rejection and non-charging provider probes passed. Existing 4 classrooms and 52 scenes were preserved; scene digest remained `0d709b22053e54899363d49d4fb4e34b`.

## Packaging and deployment

The prior account-page 500 came from missing SSR chunks. The complete `.next/server` tree is now included and the authenticated route is checked before traffic changes. Existing Zaokit-first ordering and GPT-5.4 retirement updates were merged before release.

Runtime image: `zaokit-edu:20260921-cowork-billing-v2`.
Configuration: `/opt/openmaic/compose.accounts.yml` and private `/opt/openmaic/.env.accounts.production`.
Backups and verification: `/opt/openmaic/backups/20260921-cowork-billing/`.
Only application/configuration rollback is automatic; the account/billing database is not restored over new transactions. Original database and data volume remain in place.

The deployment stopped safely when a concurrent release changed the expected version and when disk space ran low. Completed Edu build intermediates and rebuildable build cache were cleaned; current/rollback images, application data and database backups were retained. Remaining disk space should be considered before future large builds.
