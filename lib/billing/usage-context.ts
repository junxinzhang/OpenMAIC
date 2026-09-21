import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { LanguageModel } from 'ai';
import { billingPool, billingTransaction, lockBillingUser } from './store';
import { BillingError, operationCost } from './config';
import { modelTier, METERED_ACTIONS } from './policy';

type Context = {
  userId: string;
  operationId: string;
  planId: string;
  action: string;
  pending: Set<Promise<unknown>>;
};
const globals = globalThis as typeof globalThis & {
  eduBillingContext?: AsyncLocalStorage<Context>;
};
const context = (globals.eduBillingContext ??= new AsyncLocalStorage<Context>());
export async function withBillingUsage<T>(
  userId: string,
  operationId: string,
  work: () => T | Promise<T>,
): Promise<T> {
  const op = (
    await (
      await billingPool()
    ).query(
      'SELECT billing_policy,plan_id,state,action FROM edu_credit_operations WHERE id=$1 AND user_id=$2',
      [operationId, userId],
    )
  ).rows[0];
  if (!op) throw new BillingError('operation_missing', '任务记录不存在', 404);
  if (op.billing_policy !== 'cowork_v1') return work();
  if (op.state !== 'reserved')
    throw new BillingError('operation_finalized', '任务已结束，请重新开始', 409);
  const scope: Context = {
    userId,
    operationId,
    planId: op.plan_id,
    action: op.action,
    pending: new Set(),
  };
  return context.run(scope, async () => {
    const result = await work();
    await Promise.all(scope.pending);
    return result;
  });
}
export function prepareMeteredCall(model: string) {
  const owner = context.getStore();
  if (!owner) return undefined;
  if (owner.planId === 'trial' && modelTier(model) === 'pro')
    throw new BillingError('plan_required', '此模型需要付费套餐，请选择 Auto 模型或升级套餐', 402);
  const id = randomUUID();
  const ready = billingTransaction(async (db) => {
    await lockBillingUser(db, owner.userId);
    const op = (
      await db.query(
        'SELECT state,execution_outcome FROM edu_credit_operations WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [owner.operationId, owner.userId],
      )
    ).rows[0];
    if (!op || op.state !== 'reserved' || op.execution_outcome)
      throw new BillingError('operation_finalized', '任务已结束，请重新开始', 409);
    await db.query(
      'UPDATE edu_credit_operations SET execution_started_at=COALESCE(execution_started_at,now()) WHERE id=$1',
      [owner.operationId],
    );
    await db.query('INSERT INTO edu_credit_model_calls(id,operation_id,model) VALUES($1,$2,$3)', [
      id,
      owner.operationId,
      model,
    ]);
  });
  return {
    ready,
    async finish(raw: unknown) {
      await ready;
      const value = raw as { inputTokens?: unknown; outputTokens?: unknown } | null;
      const valid = (n: unknown): n is number =>
        typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 1e12;
      const input = valid(value?.inputTokens) ? value.inputTokens : null;
      const output = valid(value?.outputTokens) ? value.outputTokens : null;
      await (
        await billingPool()
      ).query(
        "UPDATE edu_credit_model_calls SET state='complete',input_tokens=$2,output_tokens=$3 WHERE id=$1 AND state='pending'",
        [id, input, output],
      );
      await Promise.all(owner.pending);
    },
    async fail() {
      await ready;
      await (
        await billingPool()
      ).query("UPDATE edu_credit_model_calls SET state='failed' WHERE id=$1 AND state='pending'", [
        id,
      ]);
    },
  };
}
/** The SDK starts streaming asynchronously; persist admission before its transport runs. */
export function waitForBilling(model: LanguageModel, ready: Promise<void>): LanguageModel {
  if (typeof model === 'string') throw new BillingError('invalid_model', '请使用已配置的模型', 400);
  return new Proxy(model, {
    get(target, key) {
      if (key === 'doStream' || key === 'doGenerate')
        return async (...args: unknown[]) => {
          await ready;
          return (Reflect.get(target, key, target) as (...a: unknown[]) => unknown).apply(
            target,
            args,
          );
        };
      return Reflect.get(target, key, target);
    },
  });
}

export function recordBillingMedia(kind: string, quantity: number): Promise<void> {
  const owner = context.getStore();
  if (!owner || !METERED_ACTIONS.has(owner.action)) return Promise.resolve();
  const action = (
    {
      image: 'image_generate',
      video: 'video_generate',
      tts: 'tts_generate',
      asr: 'transcription',
    } as Record<string, string>
  )[kind];
  if (!action) return Promise.resolve();
  const credits = operationCost(action) * (kind === 'image' ? Math.max(1, Math.ceil(quantity)) : 1);
  const pending = (async () => {
    await (
      await billingPool()
    ).query(
      'INSERT INTO edu_credit_media_calls(id,operation_id,action,credits) VALUES($1,$2,$3,$4)',
      [randomUUID(), owner.operationId, action, credits],
    );
  })();
  owner.pending.add(pending);
  void pending.catch(() => undefined);
  return pending;
}
