import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Agentwa — Console d'onboarding",
  description: "Onboarding et duplication des clients de la plateforme agent WhatsApp",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
