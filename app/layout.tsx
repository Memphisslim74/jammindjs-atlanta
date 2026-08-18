import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "JAMMIN' DJs Atlanta",
  description:
    "Atlanta DJ, MC, photo booth, lighting, and event entertainment services for weddings, mitzvahs, schools, corporate events, and private celebrations.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
