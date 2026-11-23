import { quadricsEnv } from "./quadrics-env.mjs";
function readUrl(value, name, errors, { originOnly = false } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${name} is required.`);
    return null;
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    errors.push(`${name} must be a valid HTTPS URL.`);
    return null;
  }

  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (originOnly && url.pathname !== "/")) {
    errors.push(`${name} must be an HTTPS ${originOnly ? "origin without a path" : "URL"}.`);
    return null;
  }
  return url;
}

export function validateProductionConfig(env = process.env) {
  const errors = [];
  readUrl(quadricsEnv("APP_URL", env), "QUADRICS_APP_URL", errors, { originOnly: true });
  readUrl(env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL", errors, { originOnly: true });
  if (env.NEXT_PUBLIC_SUPABASE_STORAGE_URL?.trim()) {
    readUrl(env.NEXT_PUBLIC_SUPABASE_STORAGE_URL, "NEXT_PUBLIC_SUPABASE_STORAGE_URL", errors, { originOnly: true });
  }

  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!publishableKey) errors.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required.");

  const serverSecret = env.SUPABASE_SERVER_SECRET_KEY?.trim();
  if (!serverSecret) errors.push("SUPABASE_SERVER_SECRET_KEY is required at runtime.");
  else if (publishableKey && serverSecret === publishableKey) {
    errors.push("SUPABASE_SERVER_SECRET_KEY must not contain the public key.");
  }

  const trustedClientIpHeader = quadricsEnv("TRUSTED_CLIENT_IP_HEADER", env)?.trim().toLowerCase();
  if (!["cf-connecting-ip", "x-real-ip", "x-forwarded-for"].includes(trustedClientIpHeader)) {
    errors.push("QUADRICS_TRUSTED_CLIENT_IP_HEADER must be one of cf-connecting-ip, x-real-ip, or x-forwarded-for.");
  }

  const smtpHost = quadricsEnv("SMTP_HOST", env)?.trim();
  const smtpPortValue = quadricsEnv("SMTP_PORT", env)?.trim();
  const smtpFrom = quadricsEnv("SMTP_FROM", env)?.trim();
  if (!smtpHost || /[\s\0]/.test(smtpHost)) errors.push("QUADRICS_SMTP_HOST is required and must not contain whitespace.");
  if (!smtpPortValue || !Number.isInteger(Number(smtpPortValue)) || Number(smtpPortValue) < 1 || Number(smtpPortValue) > 65535) {
    errors.push("QUADRICS_SMTP_PORT must be an integer between 1 and 65535.");
  }
  if (!smtpFrom || /[\r\n]/.test(smtpFrom)) errors.push("QUADRICS_SMTP_FROM is required and must not contain line breaks.");

  const smtpUser = quadricsEnv("SMTP_USER", env)?.trim();
  const smtpPassword = quadricsEnv("SMTP_PASSWORD", env);
  if (Boolean(smtpUser) !== Boolean(smtpPassword)) errors.push("QUADRICS_SMTP_USER and QUADRICS_SMTP_PASSWORD must be configured together.");

  const secure = quadricsEnv("SMTP_SECURE", env);
  if (secure !== undefined && secure !== "" && !["true", "false"].includes(secure)) {
    errors.push("QUADRICS_SMTP_SECURE accepts only true or false.");
  }
  const requireTls = quadricsEnv("SMTP_REQUIRE_TLS", env);
  if (requireTls !== undefined && requireTls !== "" && !["true", "false"].includes(requireTls)) {
    errors.push("QUADRICS_SMTP_REQUIRE_TLS accepts only true or false.");
  }
  const usesImplicitTls = secure === "true" || (!secure && Number(smtpPortValue) === 465);
  if (!usesImplicitTls && requireTls === "false") errors.push("Production SMTP must use TLS.");

  return errors;
}
