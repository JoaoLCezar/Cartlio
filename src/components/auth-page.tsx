import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm } from "./action-form";
import { login, signup } from "@/app/auth/actions";
import { supabaseConfig } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";

export async function AuthPage({ register = false, next }: { register?: boolean; next?: string }) {
  const configured = !!supabaseConfig();
  if (configured) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) redirect(next ?? "/painel");
  }
  return <main className="auth-page">
    <aside className="auth-aside">
      <Link href="/" className="brand-wordmark">quadrics<span>.</span></Link>
      <div className="auth-aside-copy">
        <p className="eyebrow">Um lugar para cada história</p>
        <h2>Da câmera até as mãos de quem você fotografou.</h2>
        <p>Organize seus trabalhos e crie uma experiência de entrega mais especial para cada cliente.</p>
      </div>
      <span className="text-sm text-stone-400">© {new Date().getFullYear()} Quadrics</span>
    </aside>
    <section className="auth-card">
      <Link href="/" className="brand-wordmark" aria-label="Quadrics, início">quadrics<span>.</span></Link>
      <p className="eyebrow mt-10">Acesso do fotógrafo</p>
      <h1>{register ? "Crie sua conta" : "Bem-vindo de volta"}</h1>
      <p className="mb-8 text-stone-400">Seu espaço para organizar as próximas entregas.</p>
      {configured ? <ActionForm action={register ? signup : login} label={register ? "Criar conta" : "Entrar"}>
        {next && <input type="hidden" name="next" value={next} />}
        <label className="field">E-mail<input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
        <label className="field">Senha<input name="password" type="password" autoComplete={register ? "new-password" : "current-password"} required minLength={register ? 8 : 1} maxLength={128} /></label>
        {register && <p className="text-sm text-stone-400">Use pelo menos 8 caracteres.</p>}
      </ActionForm> : <p role="status" className="rounded-xl border border-amber-400/30 p-5 text-amber-200">Estamos preparando o acesso ao Quadrics. Tente novamente mais tarde.</p>}
      {configured && !register && <p className="mt-4 text-sm text-stone-400"><Link className="text-amber-300 underline" href="/recuperar-senha">Esqueci minha senha</Link></p>}
      <p className="mt-8 text-sm text-stone-400">{register ? "Já tem uma conta? " : "Primeira vez aqui? "}<Link className="text-amber-300 underline" href={`${register ? "/login" : "/cadastro"}${next ? `?next=${encodeURIComponent(next)}` : ""}`}>{register ? "Entrar" : "Criar conta"}</Link></p>
    </section>
  </main>;
}
