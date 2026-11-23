"use client";

import { useActionState } from "react";
import type { FormState } from "@/components/action-form";
import { acceptWorkspaceInvitation } from "@/app/convite/actions";

export function AcceptWorkspaceInvitationForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(acceptWorkspaceInvitation, {});
  return <form action={formAction} className="space-y-5">
    <input type="hidden" name="token" value={token} />
    {state.error && <p role="alert" className="text-sm text-red-300">{state.error}</p>}
    <button className="button" type="submit" disabled={pending}>{pending ? "Aceitando convite…" : "Aceitar convite"}</button>
  </form>;
}
