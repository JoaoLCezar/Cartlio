"use client";

import { useActionState, type ReactNode } from "react";

export type FormState = { error?: string; success?: string };

export function ActionForm({ action, children, label }: {
  action: (state: FormState, data: FormData) => Promise<FormState>;
  children: ReactNode;
  label: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-5">
      <fieldset disabled={pending} className="space-y-5 disabled:opacity-60">{children}</fieldset>
      {state.error && <p role="alert" className="text-sm text-red-300">{state.error}</p>}
      {state.success && <p role="status" className="text-sm text-emerald-300">{state.success}</p>}
      <button disabled={pending} className="button w-full" type="submit">{pending ? "Aguarde…" : label}</button>
    </form>
  );
}
