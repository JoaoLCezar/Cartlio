import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { logout } from "@/app/auth/actions";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireUser();
  return <div className="mx-auto min-h-screen max-w-6xl px-6 py-8">
    <header className="mb-12 flex flex-wrap items-center justify-between gap-4 border-b border-white/15 pb-6">
      <Link href="/painel" className="text-2xl font-semibold">cartlio<span className="text-amber-400">.</span></Link>
      <div className="flex flex-wrap items-center gap-5 text-sm"><span className="break-all text-stone-400">{user.email}</span><form action={logout}><button className="underline">Sair</button></form></div>
    </header>
    <main>{children}</main>
  </div>;
}
