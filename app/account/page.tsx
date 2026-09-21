'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
type Account = {
  user: { email: string; name?: string };
  enabled: boolean;
  mode: 'test' | 'live';
  configured: boolean;
  paymentReview: boolean;
  available: number;
  reserved: number;
  plans: Array<{
    priceId: string;
    id: string;
    name: string;
    amount: number;
    currency: string;
    credits: number;
  }>;
  subscriptions: Array<{
    subscription_id: string;
    status: string;
    cancel_at_period_end: boolean;
    period_end: string;
  }>;
  ledger: Array<{ id: string; kind: string; credits: number; created_at: string }>;
  invoices: Array<{
    invoice_id: string;
    amount: number;
    currency: string;
    credits: number;
    period_end: string;
  }>;
};
export default function AccountPage() {
  const [data, setData] = useState<Account | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const refresh = async () => {
    try {
      const r = await fetch('/api/billing/status', { cache: 'no-store' });
      if (r.status === 401) {
        window.location.href = '/login?next=/account';
        return;
      }
      const result = await r.json();
      if (!r.ok) throw new Error(result.message || '无法读取账户');
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法读取账户');
    }
  };
  useEffect(() => {
    void refresh();
    void fetch('/api/v1/auth/providers', { cache: 'no-store' })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((providers) =>
        setGoogleEnabled(providers?.enabled === true && providers?.google === true),
      )
      .catch(() => setGoogleEnabled(false));
  }, []);
  const action = async (path: string, body?: object) => {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const result = await r.json();
      if (!r.ok) throw new Error(result.message || '操作未完成');
      if (result.url) window.location.assign(result.url);
      else window.location.assign('/login');
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作未完成');
      setBusy(false);
    }
  };
  const labels: Record<string, string> = {
    grant: '积分到账',
    reserve: '任务预留',
    settled: '任务完成',
    released: '积分退回',
    payment_review: '付款待核对',
  };
  return (
    <main className="mx-auto max-w-4xl space-y-8 p-6 md:p-12">
      <div className="flex items-center justify-between">
        <Link href="/" className="text-sm underline">
          返回课堂
        </Link>
        <button
          disabled={busy}
          onClick={() => void action('/api/v1/auth/logout')}
          className="rounded border px-4 py-2"
        >
          退出登录
        </button>
      </div>
      {data?.mode === 'test' && (
        <div
          role="status"
          className="rounded-xl border-2 border-amber-500 bg-amber-50 px-5 py-4 font-medium text-amber-950 dark:bg-amber-950 dark:text-amber-100"
        >
          测试环境 · 当前付款不会扣取真实费用，积分仅用于测试。
        </div>
      )}
      <header>
        <h1 className="text-3xl font-semibold">我的账户</h1>
        <p className="mt-2 text-muted-foreground">{data?.user.email || '正在读取账户…'}</p>
      </header>
      {googleEnabled && (
        <section className="rounded-xl border p-5">
          <h2 className="font-medium">Google 登录</h2>
          <p className="my-2 text-sm text-muted-foreground">
            绑定后可使用 Google 登录当前账户，保留已有课堂和积分。
          </p>
          <button
            onClick={() => window.location.assign('/api/v1/auth/login/google?next=/account')}
            className="inline-block rounded border px-4 py-2"
          >
            绑定或确认 Google 账户
          </button>
        </section>
      )}
      {error && (
        <p role="alert" className="rounded border border-red-400 p-4 text-red-600">
          {error}
        </p>
      )}
      {data && (
        <>
          <section className="rounded-xl border p-6">
            <h2 className="text-xl font-medium">积分余额</h2>
            <p className="my-4 text-4xl font-semibold">
              {data.available.toLocaleString()}{' '}
              <span className="text-base font-normal">积分可用</span>
            </p>
            <p>任务预留：{data.reserved.toLocaleString()} 积分</p>
            <p className="mt-3 text-sm text-muted-foreground">
              订阅积分在对应账期结束时到期。任务先预留积分，尚未执行就失败会退回；已开始的后台生成按次计费，中途取消也会扣除。结果不明的任务会保留预留积分，待核对后处理。
            </p>
            <button onClick={() => void refresh()} className="mt-4 underline">
              刷新付款和积分状态
            </button>
          </section>
          {data.paymentReview && (
            <p role="alert" className="rounded border p-4">
              付款记录正在核对，付费积分暂不可用。请联系支持处理退款或付款争议。
            </p>
          )}
          {!data.configured && (
            <p className="rounded border p-4">
              {data.enabled ? '支付尚未开放，套餐配置完成后即可订阅。' : '当前未开启付费功能。'}
            </p>
          )}
          <section>
            <h2 className="mb-4 text-xl font-medium">订阅套餐</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              {data.plans.map((p) => (
                <article key={p.id} className="space-y-3 rounded-xl border p-5">
                  <h3 className="text-lg font-semibold">{p.name}</h3>
                  <p>
                    {new Intl.NumberFormat('zh-CN', {
                      style: 'currency',
                      currency: p.currency,
                    }).format(p.amount / 100)}{' '}
                    / 月
                  </p>
                  <p>每月 {p.credits.toLocaleString()} 积分</p>
                  <button
                    disabled={!data.configured || busy}
                    onClick={() =>
                      void action('/api/billing/checkout', { plan: p.id, priceId: p.priceId })
                    }
                    className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-40"
                  >
                    订阅
                  </button>
                </article>
              ))}
            </div>
          </section>
          <section>
            <h2 className="mb-3 text-xl font-medium">当前订阅</h2>
            {data.subscriptions.length ? (
              data.subscriptions.map((s) => (
                <p key={s.subscription_id}>
                  {s.status === 'active'
                    ? '订阅有效'
                    : s.status === 'past_due'
                      ? '付款待处理'
                      : s.status === 'canceled'
                        ? '已取消'
                        : '正在确认'}{' '}
                  · 有效期至 {new Date(s.period_end).toLocaleDateString('zh-CN')}
                  {s.cancel_at_period_end ? ' · 到期后取消' : ''}
                </p>
              ))
            ) : (
              <p>暂无订阅</p>
            )}
            <button
              disabled={busy || !data.configured || !data.subscriptions.length}
              onClick={() => void action('/api/billing/portal')}
              className="mt-3 rounded border px-4 py-2 disabled:opacity-40"
            >
              管理订阅与付款方式
            </button>
          </section>
          <section>
            <h2 className="mb-3 text-xl font-medium">账单记录</h2>
            {data.invoices.length ? (
              data.invoices.map((i) => (
                <div key={i.invoice_id} className="flex justify-between border-b py-3">
                  <span>
                    {new Intl.NumberFormat('zh-CN', {
                      style: 'currency',
                      currency: i.currency,
                    }).format(i.amount / 100)}
                  </span>
                  <span>到账 {i.credits} 积分</span>
                  <span>{new Date(i.period_end).toLocaleDateString('zh-CN')} 到期</span>
                </div>
              ))
            ) : (
              <p>暂无账单</p>
            )}
          </section>
          <section>
            <h2 className="mb-3 text-xl font-medium">最近积分记录</h2>
            {data.ledger.length ? (
              data.ledger.map((l) => (
                <div key={l.id} className="flex justify-between border-b py-3">
                  <span>{labels[l.kind] || '积分调整'}</span>
                  <span>
                    {Number(l.credits) > 0 ? '+' : ''}
                    {l.credits}
                  </span>
                  <time>{new Date(l.created_at).toLocaleString('zh-CN')}</time>
                </div>
              ))
            ) : (
              <p>暂无积分变动</p>
            )}
          </section>
        </>
      )}
    </main>
  );
}
