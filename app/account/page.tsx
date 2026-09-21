'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  CreditCard,
  Gauge,
  Loader2,
  RefreshCw,
  ShieldCheck,
  UserRound,
  X,
} from 'lucide-react';

type Plan = {
  id: string;
  name: string;
  amount: number;
  currency: string;
  credits: number;
  priceId: string | null;
  concurrent?: number;
  hourly?: number;
  daily?: number;
};
type Account = {
  user: { id: string; email: string; name?: string };
  enabled: boolean;
  configured: boolean;
  portalConfigured?: boolean;
  mode: string;
  policy: string;
  catalogVersion: string;
  paymentReview: boolean;
  available: number;
  reserved: number;
  used?: number;
  limit?: number;
  plan?: string;
  planName?: string;
  periodEnd?: string | null;
  limits?: { concurrent: number; hourly: number; daily: number };
  mediaCosts?: Record<string, number>;
  plans: Plan[];
  subscriptions: Array<{
    subscription_id: string;
    status: string;
    price_id: string;
    cancel_at_period_end: boolean;
    period_end: string;
    amount?: number;
    currency?: string;
    credits?: number;
    plan_id?: string;
  }>;
  invoices: Array<{
    invoice_id: string;
    amount: number;
    currency: string;
    credits: number;
    period_start: string;
    period_end: string;
    created_at?: string;
  }>;
  ledger: Array<{ id: string; kind: string; credits: number; created_at: string }>;
  operations?: Array<{
    id: string;
    action: string;
    state: string;
    cost: number;
    charged: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    execution_outcome: string | null;
    created_at: string;
  }>;
};
type Tab = 'billing' | 'usage' | 'profile';
const number = (value: number | string | undefined | null) =>
  Number(value ?? 0).toLocaleString('zh-CN');
const money = (amount: number, currency = 'usd') =>
  new Intl.NumberFormat('zh-CN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(
    Number(amount) / 100,
  );
const date = (value: string) => new Date(value).toLocaleDateString('zh-CN');
const actions: Record<string, string> = {
  course_generate: '课堂生成',
  'agent.message': '智能体任务',
  model_request: 'AI 内容生成',
  image_generate: '图片生成',
  video_generate: '视频生成',
  tts_generate: '语音生成',
  transcription: '语音转写',
  document_extract: '文档解析',
  web_search: '搜索',
  video_render: '视频导出',
};
const button =
  'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40';
const panel = 'rounded-2xl border border-border/70 bg-card p-5 sm:p-6';

export default function AccountPage() {
  const [data, setData] = useState<Account | null>(null);
  const [tab, setTab] = useState<Tab>('billing');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [plansOpen, setPlansOpen] = useState(false);
  const planTrigger = useRef<HTMLButtonElement>(null);
  const [confirmPlan, setConfirmPlan] = useState<(Plan & { catalogVersion: string }) | null>(null);
  const [google, setGoogle] = useState(false);
  const [checkoutReturn, setCheckoutReturn] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/billing/status', { cache: 'no-store' });
      if (response.status === 401) {
        window.location.assign('/login?next=/account');
        return;
      }
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || '暂时无法读取账户信息');
      setData(result);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '暂时无法读取账户信息');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const search = new URLSearchParams(window.location.search);
    const selected = search.get('tab');
    if (selected === 'usage' || selected === 'profile') setTab(selected);
    setCheckoutReturn(search.get('checkout') === 'success');
    void fetch('/api/v1/auth/providers')
      .then((r) => r.json())
      .then((p) => setGoogle(p.google === true))
      .catch(() => undefined);
  }, [refresh]);
  useEffect(() => {
    const visibleRefresh = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const timer = setInterval(visibleRefresh, checkoutReturn ? 5000 : 15000);
    window.addEventListener('focus', visibleRefresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', visibleRefresh);
    };
  }, [refresh, checkoutReturn]);
  async function action(path: string, body?: object) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.message || value.error || '操作未完成，请重试');
      if (value.url) window.location.assign(value.url);
      else {
        setPlansOpen(false);
        setConfirmPlan(null);
        await refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作未完成，请重试');
    } finally {
      setBusy(false);
    }
  }
  const subscription = data?.subscriptions.find((s) => ['active', 'past_due'].includes(s.status));
  const displayedSubscription = subscription ?? data?.subscriptions[0];
  const isTrial = data?.plan === 'trial' || (!data?.plan && !data?.subscriptions.length);
  const canUpgrade =
    !subscription ||
    data?.plans.some(
      (p) =>
        p.amount > Number(subscription.amount ?? 0) &&
        p.credits > Number(subscription.credits ?? 0),
    );
  const limit = Number(data?.limit ?? 0),
    used = Number(data?.used ?? 0);
  const percent = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  function chooseTab(value: Tab) {
    setTab(value);
    setCheckoutReturn(false);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', value);
    url.searchParams.delete('checkout');
    window.history.replaceState(null, '', url);
  }
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-5 py-7 sm:px-8 sm:py-10">
        <header className="mb-9 flex items-center justify-between gap-4">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft size={16} />
            返回课堂
          </Link>
          <span className="text-sm font-semibold tracking-tight">Zaokit AI Edu</span>
        </header>
        <div className="grid gap-7 md:grid-cols-[200px_minmax(0,1fr)] md:gap-10">
          <aside>
            <h1 className="text-2xl font-semibold tracking-tight">账户设置</h1>
            <p className="mt-2 break-all text-xs text-muted-foreground">
              {data?.user.email ?? '管理你的订阅与使用额度'}
            </p>
            <nav aria-label="账户设置" className="mt-6 flex gap-2 overflow-auto md:flex-col">
              {(
                [
                  { id: 'billing', label: '订阅账单', icon: CreditCard },
                  { id: 'usage', label: '用量', icon: Gauge },
                  { id: 'profile', label: '个人账户', icon: UserRound },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  onClick={() => chooseTab(item.id)}
                  aria-current={tab === item.id ? 'page' : undefined}
                  className={`${button} shrink-0 justify-start ${tab === item.id ? 'bg-violet-500/10 text-violet-600 dark:text-violet-300' : 'text-muted-foreground hover:bg-muted'}`}
                >
                  <item.icon size={17} />
                  {item.label}
                </button>
              ))}
            </nav>
          </aside>
          <section className="min-w-0 space-y-5">
            {error && (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-500/25 bg-red-500/5 p-4 text-sm"
              >
                <span>{error}</span>
                <button onClick={() => void refresh()} className="underline">
                  重试
                </button>
              </div>
            )}
            {loading && !data ? (
              <div
                role="status"
                className={`${panel} flex items-center gap-3 text-muted-foreground`}
              >
                <Loader2 className="animate-spin" size={18} />
                正在读取账户…
              </div>
            ) : (
              data && (
                <>
                  {data.mode === 'test' && (
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                      当前为测试环境，不会产生真实扣款。
                    </div>
                  )}
                  {data.paymentReview && (
                    <div role="alert" className="rounded-xl border border-amber-500/30 p-4 text-sm">
                      付款记录正在核对，付费积分暂不可用，后续自动收款已暂停。
                    </div>
                  )}
                  {tab === 'billing' && (
                    <>
                      <div>
                        <h2 className="text-xl font-semibold">订阅账单</h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                          查看当前套餐、续订安排和付款记录。
                        </p>
                      </div>
                      {checkoutReturn && (
                        <div
                          role="status"
                          className="rounded-xl border border-violet-500/25 bg-violet-500/5 p-4 text-sm"
                        >
                          页面会自动刷新付款与积分状态，请以当前余额和账单记录为准。
                        </div>
                      )}
                      <div className={panel}>
                        <div className="flex flex-wrap items-start justify-between gap-5">
                          <div>
                            <p className="text-sm text-muted-foreground">当前套餐</p>
                            <h3 className="mt-2 text-3xl font-semibold">
                              {data.planName ?? (subscription ? '已订阅' : '免费试用')}
                            </h3>
                            <p className="mt-3 text-sm text-muted-foreground">
                              {displayedSubscription?.amount
                                ? `${money(displayedSubscription.amount, displayedSubscription.currency)} / 月`
                                : isTrial
                                  ? '一次性 200 积分，无需绑定付款方式'
                                  : '历史套餐额度'}
                            </p>
                          </div>
                          <span className="rounded-full bg-violet-500/10 px-3 py-1.5 text-xs font-medium text-violet-600 dark:text-violet-300">
                            {subscription
                              ? subscription.status === 'past_due'
                                ? '付款待处理'
                                : '订阅有效'
                              : isTrial
                                ? '试用账户'
                                : '套餐已到期'}
                          </span>
                        </div>
                        <div className="mt-6 flex flex-wrap items-center justify-between gap-5 border-t border-border/70 pt-5">
                          <div>
                            <p className="text-sm">
                              {data.enabled ? (
                                <>
                                  <strong className="text-lg">{number(data.available)}</strong>{' '}
                                  积分可用
                                </>
                              ) : (
                                <>当前发放额度 {number(data.limit ?? 200)} 积分</>
                              )}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {!data.enabled
                                ? '积分扣费尚未开启'
                                : subscription
                                  ? `${subscription.cancel_at_period_end ? '到期取消' : '下次续订'}：${date(subscription.period_end)}`
                                  : isTrial
                                    ? '试用额度仅发放一次，使用后不重置'
                                    : '原账期已经结束，重新订阅后发放新的额度'}
                            </p>
                          </div>
                          <button
                            ref={planTrigger}
                            onClick={() => {
                              setConfirmPlan(null);
                              setPlansOpen(true);
                            }}
                            className={`${button} bg-violet-600 text-white hover:bg-violet-500`}
                          >
                            {canUpgrade ? '升级套餐' : '查看套餐'}
                            <ArrowUpRight size={16} />
                          </button>
                        </div>
                        {subscription && (
                          <button
                            disabled={busy || !(data.portalConfigured ?? data.configured)}
                            onClick={() => void action('/api/billing/portal')}
                            className={`${button} mt-4 border border-border hover:bg-muted`}
                          >
                            管理订阅与付款方式
                            <ArrowUpRight size={15} />
                          </button>
                        )}
                      </div>
                      {!data.configured && (
                        <p className="text-sm text-muted-foreground">
                          正式订阅尚未开放。你可以先查看套餐，试用额度按实际用量结算。
                        </p>
                      )}
                      <div className={panel}>
                        <div className="mb-4 flex items-center justify-between">
                          <h3 className="font-semibold">账单记录</h3>
                          <button
                            aria-label="刷新账单"
                            onClick={() => void refresh()}
                            className="rounded-lg p-2 hover:bg-muted"
                          >
                            <RefreshCw size={15} />
                          </button>
                        </div>
                        {data.invoices.length ? (
                          <div className="divide-y divide-border/70">
                            {data.invoices.map((i) => (
                              <div
                                key={i.invoice_id}
                                className="flex flex-wrap items-center justify-between gap-3 py-4 text-sm"
                              >
                                <div>
                                  <p>{money(i.amount, i.currency)}</p>
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    {date(i.period_start)} — {date(i.period_end)}
                                  </p>
                                </div>
                                <div className="text-right">
                                  <p>当期发放 {number(i.credits)} 积分</p>
                                  <span className="text-xs text-muted-foreground">
                                    已付款 · 不代表当前剩余额度
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="py-7 text-center text-sm text-muted-foreground">
                            暂无账单。订阅付款后，账单将在这里显示。
                          </div>
                        )}
                      </div>
                    </>
                  )}
                  {tab === 'usage' && (
                    <>
                      <div className="flex items-center justify-between">
                        <div>
                          <h2 className="text-xl font-semibold">用量</h2>
                          <p className="mt-1 text-sm text-muted-foreground">
                            额度、预留和实际扣除分开记录。
                          </p>
                        </div>
                        <button
                          aria-label="刷新用量"
                          onClick={() => void refresh()}
                          className="rounded-xl border border-border p-2.5 hover:bg-muted"
                        >
                          <RefreshCw size={16} />
                        </button>
                      </div>
                      <div className={panel}>
                        <div className="flex items-baseline justify-between">
                          <h3 className="font-semibold">{data.planName ?? '当前'}额度</h3>
                          <span className="text-sm text-muted-foreground">已用 {percent}%</span>
                        </div>
                        <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-violet-500 transition-all"
                            style={{ width: `${percent}%` }}
                          />
                        </div>
                        <div className="mt-5 grid grid-cols-3 gap-3">
                          {[
                            { label: '已使用', value: data.used ?? 0 },
                            { label: '任务预留', value: data.reserved },
                            {
                              label: data.enabled ? '可用积分' : '发放额度',
                              value: data.enabled ? data.available : (data.limit ?? 200),
                            },
                          ].map((v) => (
                            <div key={v.label}>
                              <p className="text-xs text-muted-foreground">{v.label}</p>
                              <p className="mt-2 text-xl font-semibold sm:text-2xl">
                                {number(v.value)}
                              </p>
                            </div>
                          ))}
                        </div>
                        <p className="mt-4 border-t border-border/70 pt-4 text-xs text-muted-foreground">
                          {data.periodEnd
                            ? `本期总额度 ${number(limit)} 积分，${date(data.periodEnd)} 到期，不结转。`
                            : '一次性试用额度，重新登录不会重新发放。'}
                          {!data.enabled ? ' 当前未开启积分扣费。' : ''}
                        </p>
                      </div>
                      <div className={`${panel} space-y-3 text-sm`}>
                        <h3 className="font-semibold">如何计算积分</h3>
                        <p className="leading-6 text-muted-foreground">
                          文字任务按实际用量结算：每 1,000 个输入 Token 计 1 积分，输出计 4
                          积分，合计后向上取整。每次最多预留 500 积分，结束后退回未使用的部分。
                        </p>
                        <p className="leading-6 text-muted-foreground">
                          失败任务退回预留额度；中途取消按已确认的用量结算。用量尚未确认时继续显示为预留，不会当作已使用。
                        </p>
                        <div className="rounded-xl bg-muted/60 p-3 text-xs leading-6 text-muted-foreground">
                          Edu 媒体操作另按单次额度计费：图片 {data.mediaCosts?.image_generate ?? 5}{' '}
                          积分 / 张，视频 {data.mediaCosts?.video_generate ?? 20} 积分 / 次，语音{' '}
                          {data.mediaCosts?.tts_generate ?? 1} 积分 /
                          次。课堂任务中的媒体费用合并结算，不重复收取。
                        </div>
                      </div>
                      <div className={panel}>
                        <h3 className="font-semibold">任务使用记录</h3>
                        <p className="mb-4 mt-1 text-xs text-muted-foreground">
                          包含历史账期；上方余额只计算当前额度。
                        </p>
                        {data.operations?.length ? (
                          <div className="divide-y divide-border/70">
                            {data.operations.map((o) => (
                              <div
                                key={o.id}
                                className="flex items-center justify-between gap-4 py-4 text-sm"
                              >
                                <div>
                                  <p>{actions[o.action] ?? 'AI 任务'}</p>
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    {new Date(o.created_at).toLocaleString('zh-CN')}
                                    {o.input_tokens !== null && o.output_tokens !== null
                                      ? ` · 输入 ${number(o.input_tokens)} / 输出 ${number(o.output_tokens)}`
                                      : ''}
                                  </p>
                                </div>
                                <div className="shrink-0 text-right">
                                  <p>
                                    {o.state === 'reserved'
                                      ? `预留 ${number(o.cost)}`
                                      : `${number(o.charged ?? 0)} 积分`}
                                  </p>
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    {o.state === 'released'
                                      ? '已退回'
                                      : o.state === 'reserved'
                                        ? o.execution_outcome
                                          ? '用量待确认'
                                          : '进行中'
                                        : '已结算'}
                                  </p>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="py-6 text-center text-sm text-muted-foreground">
                            还没有任务使用记录。
                          </p>
                        )}
                      </div>
                    </>
                  )}
                  {tab === 'profile' && (
                    <>
                      <div>
                        <h2 className="text-xl font-semibold">个人账户</h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                          登录方式与你的课堂资料。
                        </p>
                      </div>
                      <div className={panel}>
                        <div className="flex items-center gap-3">
                          <ShieldCheck className="text-violet-500" size={20} />
                          <div>
                            <p className="text-sm font-medium">登录邮箱</p>
                            <p className="mt-1 break-all text-sm text-muted-foreground">
                              {data.user.email}
                            </p>
                          </div>
                        </div>
                        {google && (
                          <div className="mt-6 border-t border-border/70 pt-5">
                            <h3 className="text-sm font-medium">Google 登录</h3>
                            <p className="mt-2 text-sm leading-6 text-muted-foreground">
                              关联同一邮箱的 Google 账户，已有课堂与积分会保留。
                            </p>
                            <button
                              className={`${button} mt-4 border border-border hover:bg-muted`}
                              onClick={() =>
                                window.location.assign(
                                  '/api/v1/auth/login/google?next=/account?tab=profile',
                                )
                              }
                            >
                              绑定或确认 Google 账户
                              <ChevronRight size={15} />
                            </button>
                          </div>
                        )}
                      </div>
                      <button
                        className={`${button} border border-border text-muted-foreground hover:bg-muted`}
                        onClick={async () => {
                          await fetch('/api/v1/auth/logout', { method: 'POST' });
                          window.location.assign('/login');
                        }}
                      >
                        退出登录
                      </button>
                    </>
                  )}
                </>
              )
            )}
          </section>
        </div>
      </div>
      {plansOpen && data && (
        <Dialog
          open={plansOpen}
          onOpenChange={(open) => {
            if (!busy) setPlansOpen(open);
          }}
        >
          <DialogContent
            showCloseButton={false}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              planTrigger.current?.focus();
            }}
            className="block max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-3xl border border-border p-5 sm:max-w-5xl sm:p-8"
          >
            <button
              aria-label="关闭套餐比较"
              disabled={busy}
              onClick={() => setPlansOpen(false)}
              className="absolute right-4 top-4 rounded-lg p-2 hover:bg-muted"
            >
              <X size={19} />
            </button>
            <DialogTitle className="pr-8 text-2xl font-semibold tracking-tight">
              选择适合你的套餐
            </DialogTitle>
            <DialogDescription className="mt-2 text-sm text-muted-foreground">
              {data.mode === 'live'
                ? '以美元实际扣款，每月自动续订。可随时取消后续续订。'
                : '测试订阅不会产生真实扣款。'}{' '}
              积分按实际用量结算。
            </DialogDescription>
            {error && (
              <p role="alert" className="mt-4 text-sm text-red-500">
                {error}
              </p>
            )}
            <div className="mt-7 grid gap-4 md:grid-cols-3">
              {data.plans.map((p, index) => {
                const current = subscription && subscription.price_id === p.priceId;
                const upgrade =
                  subscription?.status === 'active' &&
                  Number(p.amount) > Number(subscription.amount ?? 0) &&
                  Number(p.credits) > Number(subscription.credits ?? 0);
                const canBuy =
                  data.configured &&
                  !!p.priceId &&
                  !data.paymentReview &&
                  !current &&
                  (!subscription || upgrade);
                return (
                  <article
                    key={p.id}
                    className={`relative flex flex-col rounded-2xl border p-5 ${p.id === 'pro' ? 'border-violet-500 bg-violet-500/5' : 'border-border'}`}
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="text-lg font-semibold">{p.name}</h3>
                      {p.id === 'pro' && (
                        <span className="rounded-full bg-violet-500/15 px-2 py-1 text-xs text-violet-600 dark:text-violet-300">
                          推荐
                        </span>
                      )}
                    </div>
                    <p className="mt-2 text-3xl font-semibold tracking-tight">
                      {money(p.amount, p.currency)}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">/ 月</span>
                    </p>
                    <p className="mt-4 text-sm">
                      <strong>{number(p.credits)}</strong> 积分 / 月
                    </p>
                    <ul className="my-5 flex-1 space-y-3 text-sm text-muted-foreground">
                      {[
                        'Auto 和 Pro 模型',
                        `最多 ${p.concurrent ?? (index === 0 ? 1 : 3)} 个后台任务同时运行`,
                        `${p.hourly ?? (index === 0 ? 12 : 24)} 次 / 小时 · ${p.daily ?? (index === 0 ? 60 : 120)} 次 / 天`,
                        '账期内使用，额度不结转',
                      ].map((text) => (
                        <li key={text} className="flex gap-2">
                          <Check size={15} className="mt-0.5 shrink-0 text-violet-500" />
                          {text}
                        </li>
                      ))}
                    </ul>
                    {confirmPlan?.id === p.id && upgrade ? (
                      <div className="space-y-3 rounded-xl border border-violet-500/30 p-3">
                        <p className="text-xs leading-5">
                          将立即收取 {money(confirmPlan.amount, confirmPlan.currency)}
                          ，开启新的一个月账期，并以 {number(confirmPlan.credits)}{' '}
                          积分替换剩余额度。旧额度不结转或退款。
                        </p>
                        <button
                          disabled={busy || !canBuy}
                          onClick={() =>
                            void action('/api/billing/upgrade', {
                              plan: confirmPlan.id,
                              priceId: confirmPlan.priceId,
                              catalogVersion: confirmPlan.catalogVersion,
                            })
                          }
                          className={`${button} w-full bg-violet-600 text-white`}
                        >
                          {busy ? <Loader2 size={16} className="animate-spin" /> : '确认升级'}
                        </button>
                      </div>
                    ) : (
                      <button
                        disabled={busy || !canBuy}
                        onClick={() =>
                          upgrade
                            ? setConfirmPlan({ ...p, catalogVersion: data.catalogVersion })
                            : void action('/api/billing/checkout', {
                                plan: p.id,
                                priceId: p.priceId,
                                catalogVersion: data.catalogVersion,
                              })
                        }
                        className={`${button} w-full ${p.id === 'pro' ? 'bg-violet-600 text-white' : 'border border-border hover:bg-muted'}`}
                      >
                        {current
                          ? '当前套餐'
                          : !data.configured
                            ? '尚未开放订阅'
                            : subscription && !upgrade
                              ? subscription.status === 'past_due'
                                ? '请先更新付款方式'
                                : subscription.cancel_at_period_end
                                  ? '账期结束后可订阅'
                                  : '请先取消现有续订'
                              : upgrade
                                ? `升级到 ${p.name}`
                                : `订阅 ${p.name}`}
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
            <p className="mt-5 text-xs leading-5 text-muted-foreground">
              试用账户一次性获得 200 积分，可使用 Auto 模型；所有付款和积分均归属于 Zaokit AI
              Edu，与其他产品独立。
            </p>
          </DialogContent>
        </Dialog>
      )}
    </main>
  );
}
