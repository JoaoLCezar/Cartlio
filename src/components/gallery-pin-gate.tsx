"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function GalleryPinGate({ token }: { token: string }) {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function unlock(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/g/${token}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Não foi possível abrir a galeria.");
      setPin("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível abrir a galeria.");
    } finally { setBusy(false); }
  }

  return <section className="panel mx-auto mt-12 w-full max-w-md space-y-4" aria-labelledby="gallery-pin-heading">
    <div><p className="eyebrow">Acesso protegido</p><h1 id="gallery-pin-heading" className="mt-2 text-2xl font-semibold">Digite o PIN da galeria</h1></div>
    <p className="text-sm text-stone-300">Peça o código de acesso à pessoa que compartilhou este link.</p>
    <form className="space-y-4" onSubmit={unlock}>
      <label className="field">PIN<input type="password" value={pin} onChange={event => setPin(event.target.value.replace(/\D/g, "").slice(0, 12))}
        inputMode="numeric" autoComplete="one-time-code" minLength={6} maxLength={12} required disabled={busy} /></label>
      <button type="submit" className="button" disabled={busy || pin.length < 6}>{busy ? "Verificando…" : "Abrir galeria"}</button>
    </form>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
  </section>;
}
