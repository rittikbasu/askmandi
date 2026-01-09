import "@/styles/globals.css";
import { Analytics } from "@vercel/analytics/react";
import { Geist, Geist_Mono } from "next/font/google";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

export const metadata = {
  title: "Ask Mandi",
  description:
    "Get instant answers about commodity prices from 900+ agricultural markets across India. Compare rates, find the cheapest markets and track price trends all in plain language.",
  metadataBase: new URL(`https://${process.env.VERCEL_URL}`),
  icons: {
    icon: "/favicon.png",
  },
  openGraph: {
    title: "Ask Mandi",
    description:
      "Get instant answers about commodity prices from 900+ agricultural markets across India. Compare rates, find the cheapest markets and track price trends all in plain language.",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Ask Mandi",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Ask Mandi",
    description:
      "Get instant answers about commodity prices from 900+ agricultural markets across India. Compare rates, find the cheapest markets and track price trends all in plain language.",
    images: ["/og.png"],
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="antialiased">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
