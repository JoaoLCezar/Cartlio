export function passwordResetFeedback(failed: boolean): { error?: string; success?: string } {
  if (failed) {
    return { error: "Não foi possível solicitar a recuperação agora. Tente novamente mais tarde." };
  }
  return { success: "Se houver uma conta para esse e-mail, enviaremos um link para redefinir a senha." };
}
