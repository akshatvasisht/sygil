import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Self-hosted variable fonts — avoids next/font/google static-export path bug
const inter = localFont({
  src: "./fonts/inter-latin-variable.woff2",
  variable: "--font-sans",
  display: "swap",
  weight: "100 900",
});

const jetbrainsMono = localFont({
  src: "./fonts/jetbrains-mono-latin-variable.woff2",
  variable: "--font-mono",
  display: "swap",
  weight: "100 800",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
    { media: "(prefers-color-scheme: light)", color: "#09090b" },
  ],
  colorScheme: "dark",
};

export const metadata: Metadata = {
  metadataBase: new URL(process.env["NEXT_PUBLIC_SITE_URL"] ?? "https://sygil.dev"),
  title: "Sygil — Deterministic Agent Orchestration",
  description:
    "Define your agent workflow as a graph. Sygil executes it, gates transitions, and keeps you in control.",
  keywords: [
    "agent orchestration",
    "Claude",
    "Codex",
    "workflow",
    "DAG",
    "AI automation",
  ],
  openGraph: {
    title: "Sygil",
    description: "Deterministic orchestration for probabilistic agents.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`dark ${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="bg-canvas text-body font-sans antialiased leading-relaxed">
        {children}
      </body>
    </html>
  );
}
