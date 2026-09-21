'use client';
export default function AccountError({ reset }: { reset: () => void }) {
  return (
    <main className="mx-auto max-w-xl px-6 py-20">
      <h1 className="text-2xl font-semibold">账户页面暂时无法显示</h1>
      <p className="mt-3 text-muted-foreground">请重新加载；如果仍无法显示，请稍后再试。</p>
      <button onClick={reset} className="mt-6 rounded-xl bg-violet-600 px-5 py-3 text-white">
        重新加载账户
      </button>
    </main>
  );
}
