import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "HOLE2 — Pore-dimension analysis",
  description:
    "Web interface for the HOLE2 program (Smart, Goodfellow & Wallace, 1996): load a structure, probe the pore, inspect the radius profile and download the original command-line output files.",
  keywords: ["HOLE2", "ion channel", "pore analysis", "gramicidin", "molecular visualization"],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "HOLE2 — Pore-dimension analysis",
    description:
      "Run the HOLE2 program in your browser: 3D pore-surface visualisation + original CLI output downloads.",
    siteName: "HOLE2 Web",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Load three.js + TrackballControls from CDN.
            Both are async but TrackballControls has an onload that sets
            window.__tbReady = true so the viewer can detect readiness. */}
        <script
          src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"
          async
        ></script>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              // Wait for THREE to load, then load TrackballControls dynamically
              // (ensures correct ordering without blocking page render)
              (function() {
                function loadScript(src, cb) {
                  var s = document.createElement('script');
                  s.src = src;
                  s.onload = cb;
                  document.head.appendChild(s);
                }
                function checkTHREE() {
                  if (window.THREE) {
                    loadScript('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/TrackballControls.js', function() {
                      window.__tbReady = true;
                    });
                  } else {
                    setTimeout(checkTHREE, 30);
                  }
                }
                checkTHREE();
              })();
            `,
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
