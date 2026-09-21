import { randomUUID } from 'node:crypto';
import { isAuthEnabled } from '@/lib/auth/config';
import { getRequestUser } from '@/lib/auth/session';
import { isBillingEnabled } from '@/lib/billing/config';
import { reserveCredits, releaseCredits, billingErrorResponse } from '@/lib/billing/guard';
import { after, type NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import { runClassroomGenerationJob } from '@/lib/server/classroom-job-runner';
import { createClassroomGenerationJob } from '@/lib/server/classroom-job-store';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';

const log = createLogger('GenerateClassroom API');

export const maxDuration = 30;

type PdfContent = NonNullable<GenerateClassroomInput['pdfContent']>;

function isValidPdfContent(value: unknown): value is PdfContent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const { text, images } = value as { text?: unknown; images?: unknown };
  return (
    typeof text === 'string' &&
    Array.isArray(images) &&
    images.every((item) => typeof item === 'string')
  );
}

export async function POST(req: NextRequest) {
  let requirementSnippet: string | undefined;
  let billing: { userId: string; operationId: string } | undefined;
  let queued = false;
  try {
    const user = isAuthEnabled() ? await getRequestUser(req) : null;
    if ((isAuthEnabled() || isBillingEnabled()) && !user)
      return apiError('INVALID_REQUEST', 401, '请先登录');
    const rawBody = (await req.json()) as Partial<GenerateClassroomInput>;
    requirementSnippet = rawBody.requirement?.substring(0, 60);
    const pdfContent = rawBody.pdfContent;

    if (pdfContent !== undefined && !isValidPdfContent(pdfContent)) {
      return apiError(
        'INVALID_REQUEST',
        400,
        'Invalid pdfContent: expected { text: string; images: string[] }',
      );
    }

    const body: GenerateClassroomInput = {
      requirement: rawBody.requirement || '',
      ...(pdfContent !== undefined ? { pdfContent } : {}),

      ...(rawBody.enableWebSearch != null ? { enableWebSearch: rawBody.enableWebSearch } : {}),
      ...(rawBody.webSearchProviderId ? { webSearchProviderId: rawBody.webSearchProviderId } : {}),
      ...(rawBody.webSearchApiKey ? { webSearchApiKey: rawBody.webSearchApiKey } : {}),
      ...(rawBody.webSearchModelId ? { webSearchModelId: rawBody.webSearchModelId } : {}),
      ...(rawBody.baiduSubSources ? { baiduSubSources: rawBody.baiduSubSources } : {}),
      ...(rawBody.enableImageGeneration != null
        ? { enableImageGeneration: rawBody.enableImageGeneration }
        : {}),
      ...(rawBody.enableVideoGeneration != null
        ? { enableVideoGeneration: rawBody.enableVideoGeneration }
        : {}),
      ...(rawBody.enableTTS != null ? { enableTTS: rawBody.enableTTS } : {}),
      ...(rawBody.agentMode ? { agentMode: rawBody.agentMode } : {}),
    };
    const { requirement } = body;

    if (!requirement) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: requirement');
    }

    const baseUrl = buildRequestOrigin(req);
    const jobId = nanoid(10);
    if (isBillingEnabled() && user) {
      const key = req.headers.get('idempotency-key');
      if (key && !/^[A-Za-z0-9_.:-]{1,120}$/.test(key))
        return apiError('INVALID_REQUEST', 400, 'Invalid idempotency key');
      const operationId = `classroom:${user.id}:${key || randomUUID()}`;
      try {
        await reserveCredits(user.id, operationId, 'course_generate');
      } catch (error) {
        return billingErrorResponse(error);
      }
      billing = { userId: user.id, operationId };
    }
    const job = await createClassroomGenerationJob(jobId, body, {
      ownerId: user?.id,
      billingOperationId: billing?.operationId,
    });
    const pollUrl = `${baseUrl}/api/generate-classroom/${jobId}`;

    after(() =>
      runClassroomGenerationJob(jobId, body, baseUrl, {
        ownerId: user?.id,
        billingOperationId: billing?.operationId,
      }),
    );
    queued = true;

    return apiSuccess(
      {
        jobId,
        status: job.status,
        step: job.step,
        message: job.message,
        pollUrl,
        pollIntervalMs: 5000,
      },
      202,
    );
  } catch (error) {
    if (billing && !queued)
      await releaseCredits(billing.userId, billing.operationId).catch(() => undefined);
    log.error(
      `Classroom generation job creation failed [requirement="${requirementSnippet ?? 'unknown'}..."]:`,
      error,
    );
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to create classroom generation job',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
