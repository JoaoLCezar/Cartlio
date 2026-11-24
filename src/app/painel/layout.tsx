import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { logout } from "@/app/auth/actions";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireUser();
  return <div className="dashboard-shell min-h-screen">
    <header className="dashboard-header">
      <Link href="/painel" className="brand-wordmark">quadrics<span>.</span></Link>
      <div className="account-actions"><span className="break-all">{user.email}</span><form action={logout}><button>Sair</button></form></div>
    </header>
    <main>{children}</main>
  </div>;
}
