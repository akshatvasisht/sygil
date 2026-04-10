import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Self-hosted variable fonts — avoids next/font/google static-export path bug (vercel/next.js#58234)
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

export const metadata: Metadata = {
  title: "Sigil — Deterministic Agent Orchestration",
  description:
    "Define your agent workflow as a graph. Sigil executes it, gates transitions, and keeps you in control.",
  keywords: [
    "agent orchestration",
    "Claude",
    "Codex",
    "workflow",
    "DAG",
    "AI automation",
  ],
  openGraph: {
    title: "Sigil",
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
