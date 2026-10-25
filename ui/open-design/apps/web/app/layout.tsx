import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { I18nProvider } from '../src/i18n';
import '@excalidraw/excalidraw/index.css';
import '../src/index.css';
import '../src/styles/home/index.css';
import { MATOS_PRODUCT_DESCRIPTION, MATOS_PRODUCT_NAME } from '../src/branding';

export const metadata: Metadata = {
  title: MATOS_PRODUCT_NAME,
  applicationName: MATOS_PRODUCT_NAME,
  description: MATOS_PRODUCT_DESCRIPTION,
  icons: {
    icon: '/app-icon.png',
    apple: '/app-icon.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#F4EFE6',
  // The phone app loads this UI in a fullscreen WebView. Without
  // `viewport-fit=cover` iOS keeps the page letterboxed out of the notch
  // and resolves every `env(safe-area-inset-*)` to 0 — which would turn
  // the safe-area paddings in entry-layout.css (top bar, entry-main
  // bottom, onboarding bands) into dead code exactly where they matter.
  // Desktop browsers ignore viewport-fit, so this is phone-only.
  width: 'device-width',
  initialScale: 1,
  // iOS WebKit auto-zooms the page when a focused text input computes to
  // <16px and never zooms back out, leaving the phone WebView stuck
  // half-zoomed. maximum-scale=1 suppresses that focus auto-zoom. The
  // usual a11y objection is weighed and accepted: this UI ships inside
  // the phone app's fullscreen WebView, and iOS Safari ≥10 ignores
  // maximum-scale for user pinch gestures anyway. Pairs with the ≥16px
  // touch-input floor in chat-mobile.css.
  maximumScale: 1,
  viewportFit: 'cover',
};

/**
 * Inline script that runs before React hydrates to apply the saved theme
 * preference without a flash of unstyled content. It reads the same
 * localStorage key used by `state/config.ts` and sets `data-theme` on
 * `<html>` immediately — before any CSS or React paint.
 * Keep the accent variable mix ratios in sync with `accentVars()` in
 * `src/state/appearance.ts`; this script cannot import application modules.
 */
const themeInitScript = `(function(){try{var c=JSON.parse(localStorage.getItem('open-design:config')||'{}');var t=c.theme;if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);var a=typeof c.accentColor==='string'&&/^#[0-9a-fA-F]{6}$/.test(c.accentColor.trim())?c.accentColor.trim().toLowerCase():'#c96442';var s=document.documentElement.style;s.setProperty('--accent',a);s.setProperty('--accent-strong','color-mix(in srgb, '+a+' 86%, var(--text-strong))');s.setProperty('--accent-soft','color-mix(in srgb, '+a+' 22%, var(--bg-panel))');s.setProperty('--accent-tint','color-mix(in srgb, '+a+' 12%, var(--bg-panel))');s.setProperty('--accent-hover','color-mix(in srgb, '+a+' 90%, var(--text-strong))');}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang='en' suppressHydrationWarning>
      {/* eslint-disable-next-line @next/next/no-sync-scripts */}
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: intentional theme-init inline script to prevent FOUC */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body suppressHydrationWarning>
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
