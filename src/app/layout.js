import { Inter, Space_Grotesk } from "next/font/google";
import "material-symbols/outlined.css";
import "./globals.css";
import { ThemeProvider } from "@/shared/components/ThemeProvider";
import "@/lib/network/initOutboundProxy"; // Auto-initialize outbound proxy env
import "@/shared/services/bootstrap"; // Auto-run initializeApp (watchdog, auto-resume tunnel)
import { initConsoleLogCapture } from "@/lib/consoleLogBuffer";
import { RuntimeI18nProvider } from "@/i18n/RuntimeI18nProvider";

// Hook console immediately at module load time (server-side only, runs once)
initConsoleLogCapture();

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

// Space Grotesk is the Kodelyth brand display font. Used for the kRouter
// wordmark in the sidebar + login page; loaded with weights 500/600/700 so
// the same family can drive both medium-weight UI labels and bold marks.
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-space-grotesk",
  display: "swap",
});

export const metadata = {
  title: "kRouter — Kodelyth AI Infrastructure",
  description: "One endpoint for all your AI providers. Manage keys, monitor usage, and scale effortlessly. By Kodelyth.",
  icons: {
    icon: "/favicon.svg",
  },
};

export const viewport = {
  themeColor: "#0a0a0a",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `if(document.fonts&&document.fonts.ready){document.fonts.ready.then(function(){document.documentElement.classList.add('fonts-loaded')})}else{document.documentElement.classList.add('fonts-loaded')}`,
          }}
        />
      </head>
      {/* suppressHydrationWarning silences the one-level mismatch caused by browser
          extensions (Grammarly, LastPass, ColorZilla, etc.) that inject attributes
          like `data-gr-ext-installed` / `data-new-gr-c-s-check-loaded` into <body>
          before React hydrates. The mismatch is cosmetic — React ignores the
          unknown attributes — but the dev overlay surfaces a noisy warning we
          can't act on (it's the user's extension, not our code). Matches the
          same prop already on <html> above. */}
      <body className={`${inter.variable} ${spaceGrotesk.variable} font-sans antialiased`} suppressHydrationWarning>
        <ThemeProvider>
          <RuntimeI18nProvider>
            {children}
          </RuntimeI18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
