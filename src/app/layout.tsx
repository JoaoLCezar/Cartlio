import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Quadrics — Entregue suas fotografias com cuidado",
  description: "Galerias para fotógrafos e seus clientes.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
