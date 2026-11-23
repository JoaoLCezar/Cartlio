"use client";

import { useActionState, type FormEvent } from "react";
import type { FormState } from "@/components/action-form";

export function DeleteCustomerForm({ action, customerName }: {
  action: (state: FormState, data: FormData) => Promise<FormState>;
  customerName: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  function confirmDelete(event: FormEvent<HTMLFormElement>) {
    if (!window.confirm(`Excluir o cliente “${customerName}”? Galerias vinculadas precisam ser desvinculadas antes.`)) event.preventDefault();
  }
  return <form action={formAction} onSubmit={confirmDelete} className="mt-4 space-y-3">
    <button className="text-sm text-red-300 underline" type="submit" disabled={pending}>{pending ? "Excluindo…" : "Excluir cliente"}</button>
    {state.error && <p role="alert" className="text-sm text-red-300">{state.error}</p>}
    {state.success && <p role="status" className="text-sm text-emerald-300">{state.success}</p>}
  </form>;
}
