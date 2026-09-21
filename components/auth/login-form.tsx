'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
export function LoginForm() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallenge] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [next, setNext] = useState('/');
  const [providers, setProviders] = useState<{
    enabled: boolean;
    google: boolean;
    email: boolean;
  } | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNext(params.get('next') || '/');
    setError(params.get('error') || '');
    const incoming = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (incoming) {
      setToken(incoming);
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    fetch('/api/v1/auth/providers')
      .then((r) => r.json())
      .then(setProviders)
      .catch(() => setError('暂时无法连接登录服务。'));
  }, []);
  async function submit(verify: boolean) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/v1/auth/login/email${verify ? '/verify' : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          verify ? { email, code, challengeId, token: token || undefined, next } : { email },
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '登录失败，请重试。');
      if (verify) window.location.assign(data.next || '/');
      else setChallenge(data.challengeId);
    } catch (e) {
      setError(e instanceof Error ? e.message : '请稍后重试。');
    } finally {
      setBusy(false);
    }
  }
  const input =
    'w-full rounded-lg border border-neutral-300 bg-white px-4 py-3 text-neutral-900 outline-none focus:ring-2 focus:ring-violet-500';
  const button =
    'w-full rounded-lg bg-violet-600 px-4 py-3 font-medium text-white hover:bg-violet-700 disabled:opacity-50';
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-5 py-12 text-neutral-900">
      <section className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
        <Link href="/" className="text-sm font-semibold text-violet-700">
          Zaokit Edu
        </Link>
        <h1 className="mt-6 text-3xl font-semibold">欢迎回来</h1>
        <p className="mb-7 mt-2 text-sm text-neutral-600">登录后继续创建课程，管理你的学习内容。</p>
        {providers?.enabled === false ? (
          <p role="status">账号登录尚未启用。</p>
        ) : (
          <>
            {token ? (
              <>
                <p className="mb-4 text-sm">点击下方按钮，确认使用邮件链接登录。</p>
                <button className={button} disabled={busy} onClick={() => submit(true)}>
                  确认登录
                </button>
              </>
            ) : (
              <>
                {providers?.google && (
                  <a
                    className="mb-6 block w-full rounded-lg border border-neutral-300 px-4 py-3 text-center font-medium hover:bg-neutral-50"
                    href={`/api/v1/auth/login/google?next=${encodeURIComponent(next)}`}
                  >
                    使用 Google 登录
                  </a>
                )}
                {providers?.email && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void submit(Boolean(challengeId));
                    }}
                    className="space-y-4"
                  >
                    <label className="block text-sm font-medium">
                      邮箱
                      <input
                        className={`${input} mt-2`}
                        type="email"
                        autoComplete="email"
                        required
                        maxLength={254}
                        value={email}
                        onChange={(e) => {
                          setEmail(e.target.value);
                          setChallenge('');
                          setCode('');
                        }}
                        placeholder="you@example.com"
                      />
                    </label>
                    {challengeId && (
                      <>
                        <p role="status" className="text-sm text-neutral-600">
                          邮件已发送，请输入 6 位验证码，或打开邮件中的登录链接。15 分钟内有效。
                        </p>
                        <label className="block text-sm font-medium">
                          验证码
                          <input
                            className={`${input} mt-2`}
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            pattern="[0-9]{6}"
                            maxLength={6}
                            required
                            value={code}
                            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                          />
                        </label>
                      </>
                    )}
                    <button
                      className={button}
                      disabled={busy || Boolean(challengeId && code.length !== 6)}
                    >
                      {busy ? '请稍候…' : challengeId ? '验证并登录' : '发送登录邮件'}
                    </button>
                    {challengeId && (
                      <button
                        type="button"
                        className="w-full text-sm text-violet-700"
                        disabled={busy}
                        onClick={() => submit(false)}
                      >
                        重新发送
                      </button>
                    )}
                  </form>
                )}
                {providers && !providers.google && !providers.email && <p>登录方式暂未配置。</p>}
              </>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="mt-5 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}
        <p className="mt-7 text-xs leading-5 text-neutral-500">
          首次登录将为你创建 Zaokit Edu 账户。Google 与邮箱可在验证后关联同一账户。
        </p>
      </section>
    </main>
  );
}
