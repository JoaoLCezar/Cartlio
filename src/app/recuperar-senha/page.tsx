import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { requestPasswordReset } from "@/app/auth/actions";
import { supabaseConfig } from "@/lib/supabase/config";

export const dynamic = "force-dynamic";

export default function RecoverPasswordPage() {
  const configured = !!supabaseConfig();
  return <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
    <Link href="/" className="mb-10 text-2xl font-semibold">quadrics<span className="text-amber-400">.</span></Link>
    <h1 className="mb-3 text-3xl font-semibold">Recuperar senha</h1>
    <p className="mb-8 text-stone-400">Informe o e-mail da conta. Se ele estiver cadastrado, enviaremos um link para criar uma nova senha.</p>
    {configured ? <ActionForm action={requestPasswordReset} label="Enviar link de recuperação">
      <label className="field">E-mail<input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
    </ActionForm> : <p role="status" className="rounded-xl border border-amber-400/30 p-5 text-amber-200">Estamos preparando o acesso ao Quadrics. Tente novamente mais tarde.</p>}
    <p className="mt-8 text-sm text-stone-400"><Link className="text-amber-300 underline" href="/login">Voltar para entrar</Link></p>
  </main>;
}
