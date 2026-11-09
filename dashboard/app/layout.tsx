import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "OI Sniper: Quantitative Futures Execution Workstation",
  description: "High-performance CoinGlass OI/Volume quantitative execution trading bot workstation",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} dark`}
      data-theme="dark"
      style={{ colorScheme: "dark" }}
    >
      <body className="min-h-screen bg-[var(--bg)] text-[var(--text)] antialiased font-sans selection:bg-sky-500/20">
        <div className="bg-glow" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
