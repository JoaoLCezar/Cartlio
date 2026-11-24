export function safeInvitationReturnPath(value: unknown): string | null {
  return typeof value === "string" && /^\/convite\/[0-9a-f]{64}$/.test(value) ? value : null;
}

export function authReturnPath(value: unknown): string {
  return safeInvitationReturnPath(value) ?? "/painel";
}
