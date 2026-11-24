import { quadricsEnv } from "./quadrics-env.mjs";
import nodemailer from "nodemailer";

const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const safeHeader = value => String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();

export function smtpSettings(mode, env = process.env) {
  if (mode !== "--local" && mode !== "--remote") throw new Error("Escolha explicitamente --local ou --remote.");
  const local = mode === "--local";
  const host = quadricsEnv("SMTP_HOST", env)?.trim() || (local ? "127.0.0.1" : "");
  const port = Number(quadricsEnv("SMTP_PORT", env) || (local ? 54325 : 0));
  const from = quadricsEnv("SMTP_FROM", env)?.trim() || (local ? "Quadrics <notificacoes@quadrics.local>" : "");
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !from) {
    throw new Error("Configure QUADRICS_SMTP_HOST, QUADRICS_SMTP_PORT e QUADRICS_SMTP_FROM para entregar notificações.");
  }
  const secureSetting = quadricsEnv("SMTP_SECURE", env);
  const secure = secureSetting === "true" || (!secureSetting && port === 465);
  if (secureSetting && !["true", "false"].includes(secureSetting)) {
    throw new Error("QUADRICS_SMTP_SECURE aceita somente true ou false.");
  }
  if (/[\r\n]/.test(from)) throw new Error("Remetente SMTP inválido.");
  const username = quadricsEnv("SMTP_USER", env)?.trim();
  const password = quadricsEnv("SMTP_PASSWORD", env);
  if (Boolean(username) !== Boolean(password)) throw new Error("Configure usuário e senha SMTP juntos.");
  return {
    host,
    port,
    secure,
    ignoreTLS: local,
    requireTLS: !local && !secure && quadricsEnv("SMTP_REQUIRE_TLS", env) !== "false",
    connectionTimeout: 10_000,
    greetingTimeout: 5_000,
    socketTimeout: 20_000,
    from,
    ...(username && password ? { auth: { user: username, pass: password } } : {}),
  };
}

export function createGalleryNotificationTransport(mode, env = process.env) {
  const settings = smtpSettings(mode, env);
  const { from, ...transportOptions } = settings;
  return { from, transport: nodemailer.createTransport(transportOptions) };
}

export function galleryNotificationMessage(notification, appUrl = "") {
  const title = safeHeader(notification.gallery_title) || "Galeria";
  const name = safeHeader(notification.client_name) || "Cliente";
  if (notification.notification_type === "selection_submitted") {
    const subject = `Nova seleção recebida: ${title}`;
    const galleryUrl = appUrl && notification.tenant_id && notification.gallery_id
      ? `${appUrl.replace(/\/$/, "")}/painel/${encodeURIComponent(notification.tenant_id)}/galerias/${encodeURIComponent(notification.gallery_id)}`
      : null;
    return {
      subject,
      text: [
        `A seleção de fotos da galeria “${title}” foi enviada.`,
        "",
        `Cliente: ${name}`,
        `Fotos escolhidas: ${notification.selected_count}`,
        galleryUrl ? `Abrir galeria no Quadrics: ${galleryUrl}` : "Acesse o painel Quadrics para revisar a seleção.",
      ].join("\n"),
    };
  }
  if (notification.notification_type === "selection_revision_requested") {
    const message = String(notification.message ?? "").trim();
    return {
      subject: `Ajustes solicitados: ${title}`,
      text: [
        `Olá, ${name}.`,
        "",
        `O fotógrafo pediu ajustes na sua seleção da galeria “${title}”:`,
        "",
        message,
        "",
        "Abra novamente o link da galeria que você recebeu para atualizar e enviar suas escolhas.",
      ].join("\n"),
    };
  }
  throw new Error("Tipo de notificação desconhecido.");
}

export async function deliverGalleryNotifications({ client, transport, from, appUrl = "", limit = 10, shareId = null }) {
  const claimed = await client.rpc("claim_gallery_notifications", {
    p_limit: limit,
    p_share_id: shareId,
    p_token: null,
  });
  if (claimed.error) throw new Error("Não foi possível obter notificações pendentes.");
  const notifications = Array.isArray(claimed.data) ? claimed.data : [];
  const summary = { examined: notifications.length, sent: 0, retry: 0, failed: 0, pruned: 0 };
  for (const notification of notifications) {
    let success = false;
    try {
      if (!validEmail.test(notification.recipient_email)) throw new Error("invalid recipient");
      const { subject, text } = galleryNotificationMessage(notification, appUrl);
      await transport.sendMail({
        from,
        to: notification.recipient_email,
        subject,
        text,
        messageId: `<${notification.id}@cartlio>`,
      });
      success = true;
    } catch {
      // Keep recipient addresses and provider responses out of logs and database errors.
    }
    const finished = await client.rpc("finish_gallery_notification", {
      p_id: notification.id,
      p_success: success,
      p_error_code: success ? null : "smtp_send_failed",
    });
    if (finished.error || finished.data !== true) throw new Error("Não foi possível atualizar o estado da notificação.");
    if (success) summary.sent += 1;
    else if (notification.attempts >= 5) summary.failed += 1;
    else summary.retry += 1;
  }
  const pruned = await client.rpc("prune_gallery_notification_outbox", { p_retention_days: 90 });
  if (pruned.error || !Number.isInteger(pruned.data)) throw new Error("Não foi possível aplicar a retenção da fila de notificações.");
  summary.pruned = pruned.data;
  return summary;
}
