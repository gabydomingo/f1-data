import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "F1 Telemetry Engine",
  description:
    "Análisis de telemetría de Fórmula 1: recorré cualquier vuelta metro a metro, con mapa de pista, visor 3D y un modelo de degradación de neumáticos entrenado sobre la temporada completa.",
  keywords: ["Fórmula 1", "telemetría", "data engineering", "machine learning", "FastF1"],
  authors: [{ name: "Gabriel" }],
  
  openGraph: {
    title: "F1 Telemetry Engine",
    description:
      "Telemetría de F1 vuelta a vuelta, con mapa de pista, visor 3D y predicción de estrategia.",
    type: "website",
    locale: "es_AR",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#121212",
  // El dashboard ocupa exactamente la ventana: sin esto, en móvil el navegador
  // deja rebotar la página al hacer scroll.
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="h-full overflow-hidden bg-[#121212]">{children}</body>
    </html>
  );
}
