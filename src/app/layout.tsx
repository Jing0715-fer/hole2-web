import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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

export const metadata: Metadata = {
  title: "HOLE2 Web — Ion-channel pore analysis studio",
  description: "Web GUI for the HOLE2 program (Smart, Goodfellow & Wallace, 1996): upload a PDB structure, configure the pore probe, visualise the pore surface in 3D and download the original command-line output files.",
  keywords: ["HOLE2", "ion channel", "pore analysis", "gramicidin", "molecular visualization", "three.js", "MolVision"],
  authors: [{ name: "HOLE2 Web App" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "HOLE2 Web — Ion-channel pore analysis studio",
    description: "Run the HOLE2 program in your browser: 3D pore-surface visualisation + original CLI output downloads.",
    url: "https://chat.z.ai",
    siteName: "HOLE2 Web",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "HOLE2 Web",
    description: "Run the HOLE2 program in your browser: 3D pore-surface visualisation + original CLI output downloads.",
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
        {/* Load three.js + OrbitControls from CDN — avoids bundling the 23 MB
            npm package (which causes Turbopack OOM crashes in the sandbox). */}
        <script
          src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"
          async
        ></script>
        {/* OrbitControls from the three.js examples — the official, well-tested
            implementation with proper gimbal-lock handling, damping, and
            unlimited rotation. */}
        <script
          src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"
          async
        ></script>
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
