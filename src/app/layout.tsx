/*
 * Root layout for the Pokemon Draft League app.
 *
 * Sets up the global fonts, dark themed background, and shared top navigation
 * shell that every route renders inside.
 */

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { TopNav } from "@/components/top-nav";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * Static metadata (title/description) applied to the document head.
 */
export const metadata: Metadata = {
  title: "Pokémon Draft League",
  description:
    "League management, draft tracking, and team strategy for Pokémon fantasy leagues.",
};

/**
 * Wraps every route in the HTML/body scaffold with the themed background and
 * shared top navigation.
 *
 * @param props - Next.js layout props.
 * @param props.children - The rendered page content for the current route.
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      style={{ backgroundColor: "#020817" }}
    >
      <body
        className="min-h-full flex flex-col"
        style={{
          margin: 0,
          minHeight: "100vh",
          background:
            "radial-gradient(circle at top, rgba(245, 158, 11, 0.12), transparent 28%), linear-gradient(180deg, #020817 0%, #0f172a 100%)",
          color: "#e2e8f0",
        }}
      >
        <TopNav />
        {children}
      </body>
    </html>
  );
}
