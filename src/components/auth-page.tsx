import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm } from "./action-form";
import { login, signup } from "@/app/auth/actions";
import { supabaseConfig } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";

export async function AuthPage({ register = false }: { register?: boolean }) {
  const configured = !!supabaseConfig();
  if (configured) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) redirect("/painel");
  }
  return <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
    <Link href="/" className="mb-10 text-2xl font-semibold">cartlio<span className="text-amber-400">.</span></Link>
    <h1 className="mb-3 text-3xl font-semibold">{register ? "Crie sua conta" : "Bem-vindo de volta"}</h1>
    <p className="mb-8 text-stone-400">Seu espaço para organizar as próximas entregas.</p>
    {configured ? <ActionForm action={register ? signup : login} label={register ? "Criar conta" : "Entrar"}>
      <label className="field">E-mail<input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
      <label className="field">Senha<input name="password" type="password" autoComplete={register ? "new-password" : "current-password"} required minLength={register ? 8 : 1} maxLength={128} /></label>
      {register && <p className="text-sm text-stone-400">Use pelo menos 8 caracteres.</p>}
    </ActionForm> : <p role="status" className="rounded-xl border border-amber-400/30 p-5 text-amber-200">Estamos preparando o acesso ao Cartlio. Tente novamente mais tarde.</p>}
    <p className="mt-8 text-sm text-stone-400">{register ? "Já tem uma conta? " : "Primeira vez aqui? "}<Link className="text-amber-300 underline" href={register ? "/login" : "/cadastro"}>{register ? "Entrar" : "Criar conta"}</Link></p>
  </main>;
}
