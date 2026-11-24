import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { updatePassword } from "@/app/auth/actions";
import { createClient } from "@/lib/supabase/server";
import { supabaseConfig } from "@/lib/supabase/config";

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage() {
  if (!supabaseConfig()) return <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16"><p role="status" className="rounded-xl border border-amber-400/30 p-5 text-amber-200">Estamos preparando o acesso ao Quadrics. Tente novamente mais tarde.</p></main>;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
    <Link href="/" className="mb-10 text-2xl font-semibold">quadrics<span className="text-amber-400">.</span></Link>
    <h1 className="mb-3 text-3xl font-semibold">Crie uma nova senha</h1>
    <p className="mb-8 text-stone-400">Escolha uma senha de 8 a 128 caracteres para sua conta.</p>
    <ActionForm action={updatePassword} label="Salvar nova senha">
      <label className="field">Nova senha<input name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={128} /></label>
      <label className="field">Confirme a nova senha<input name="password_confirmation" type="password" autoComplete="new-password" required minLength={8} maxLength={128} /></label>
    </ActionForm>
  </main>;
}
