import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';
import '@openmaic/renderer/fonts.css';
import 'animate.css';
import 'katex/dist/katex.min.css';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { I18nProvider } from '@/lib/hooks/use-i18n';
import { Toaster } from '@/components/ui/sonner';
import { ServerProvidersInit } from '@/components/server-providers-init';
import { StorageHealthNotice } from '@/components/storage-health-notice';
import { AccessCodeGuard } from '@/components/access-code-guard';
import { ProSwapWatcher } from '@/components/workbench/ProSwapWatcher';
import { isAuthEnabled } from '@/lib/auth/config';
import Link from 'next/link';
import { AccountSessionBoundary } from '@/components/auth/account-session-boundary';

// The UI font is loaded from @fontsource's stylesheet rather than next/font,
// because only the stylesheet carries the per-subset `unicode-range`
// declarations. Pointing next/font at `inter-latin-wght-normal.woff2` loaded
// exactly one subset, so every character outside Latin — Cyrillic for ru-RU,
// tone-marked letters for vi-VN — fell back to an arbitrary OS font and
// rendered in a different typeface mid-word.
//
// Declaring the other subset files as sibling faces of the same family does not
// fix it either: faces with identical descriptors and no `unicode-range` do not
// fall through per glyph, so the browser simply picks one.
//
// `--font-sans` moves to globals.css since the family no longer comes from
// next/font's generated class.
import '@fontsource-variable/inter';

export const metadata: Metadata = {
  title: 'Zaokit AI Edu',
  description:
    'The open-source AI interactive classroom. Upload a PDF to instantly generate an immersive, multi-agent learning experience.',
};

// Account mode is deployment configuration, never a build-time decision.
// In particular, Docker builds must not pre-render an unpartitioned layout.
export const dynamic = 'force-dynamic';

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${GeistSans.variable} ${GeistMono.variable} antialiased`}
        suppressHydrationWarning
      >
        <ThemeProvider>
          <I18nProvider>
            <AccountSessionBoundary enabled={isAuthEnabled()}>
              <ServerProvidersInit />
              <ProSwapWatcher />
              {isAuthEnabled() && (
                <Link
                  href="/account"
                  className="fixed right-4 bottom-4 z-40 rounded-full border bg-background px-4 py-2 text-sm shadow-sm hover:bg-muted"
                >
                  账户与积分
                </Link>
              )}
              <AccessCodeGuard>{children}</AccessCodeGuard>
              <Toaster position="top-center" />
              {/* After the Toaster: this one raises a toast on mount when
                persistence is already broken, and a toast raised before its
                host exists has nowhere to go. */}
              <StorageHealthNotice />
            </AccountSessionBoundary>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
