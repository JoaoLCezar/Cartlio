export function safeErrorMessage(stderr, maxLength = 300) {
  const line = String(stderr ?? "").trim().split(/\r?\n/).find(Boolean);
  if (!line) return "A tarefa falhou sem informar detalhes.";

  let safeLine = line
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:access_token|refresh_token|token|key|secret|password)=)[^&\s]+/gi, "$1[redacted]");
  for (const [name, secret] of Object.entries(process.env)) {
    if (secret && /(?:SECRET|SECRET_KEY|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|ACCESS_KEY)$/i.test(name)) {
      safeLine = safeLine.replaceAll(secret, "[redacted]");
    }
  }
  return safeLine.slice(0, maxLength);
}
