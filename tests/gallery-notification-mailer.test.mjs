import assert from "node:assert/strict";
import test from "node:test";
import {
  deliverGalleryNotifications,
  galleryNotificationMessage,
  smtpSettings,
} from "../scripts/lib/gallery-notification-mailer.mjs";

test("local SMTP defaults to the local Mailpit relay without credentials", () => {
  assert.deepEqual(smtpSettings("--local", {}), {
    host: "127.0.0.1", port: 54325, secure: false, ignoreTLS: true, requireTLS: false,
    connectionTimeout: 10_000, greetingTimeout: 5_000, socketTimeout: 20_000,
    from: "Quadrics <notificacoes@quadrics.local>",
  });
});

test("remote SMTP requires a host, sender, and paired credentials with TLS", () => {
  assert.throws(() => smtpSettings("--remote", {}), /QUADRICS_SMTP_HOST/);
  assert.throws(() => smtpSettings("--remote", {
    CARTLIO_SMTP_HOST: "smtp.example.test", CARTLIO_SMTP_PORT: "587", CARTLIO_SMTP_FROM: "Cartlio <mail@example.test>",
    CARTLIO_SMTP_USER: "cartlio",
  }), /usuário e senha/);
  const settings = smtpSettings("--remote", {
    CARTLIO_SMTP_HOST: "smtp.example.test", CARTLIO_SMTP_PORT: "587", CARTLIO_SMTP_FROM: "Cartlio <mail@example.test>",
    CARTLIO_SMTP_USER: "cartlio", CARTLIO_SMTP_PASSWORD: "secret",
  });
  assert.equal(settings.requireTLS, true);
  assert.deepEqual(settings.auth, { user: "cartlio", pass: "secret" });
  assert.throws(() => smtpSettings("--remote", {
    CARTLIO_SMTP_HOST: "smtp.example.test", CARTLIO_SMTP_PORT: "587", CARTLIO_SMTP_FROM: "mail@example.test\r\nBcc: attacker@example.test",
  }), /Remetente SMTP inválido/);
});

test("selection notification addresses the photographer without exposing a share token", () => {
  const result = galleryNotificationMessage({
    id: "outbox-id", notification_type: "selection_submitted", tenant_id: "tenant-id", gallery_id: "gallery-id",
    gallery_title: "Ensaio da família", client_name: "Cliente", selected_count: 8,
  }, "https://cartlio.example");
  assert.equal(result.subject, "Nova seleção recebida: Ensaio da família");
  assert.match(result.text, /Fotos escolhidas: 8/);
  assert.match(result.text, /https:\/\/cartlio\.example\/painel\/tenant-id\/galerias\/gallery-id/);
  assert.doesNotMatch(result.text, /outbox-id|share_token|[0-9a-f]{64}/);
});

test("revision email includes the photographer note and points to the existing gallery link", () => {
  const result = galleryNotificationMessage({
    notification_type: "selection_revision_requested", gallery_title: "Ensaio", client_name: "Cliente",
    message: "Revise a foto 3.",
  });
  assert.equal(result.subject, "Ajustes solicitados: Ensaio");
  assert.match(result.text, /Revise a foto 3\./);
  assert.match(result.text, /link da galeria que você recebeu/);
  assert.doesNotMatch(result.text, /PIN|[0-9a-f]{64}/i);
});

test("delivery sends claimed messages and marks success while keeping provider failures private", async () => {
  const calls = [];
  const client = { async rpc(name, args) {
    calls.push([name, args]);
    if (name === "prune_gallery_notification_outbox") return { data: 0, error: null };
    if (name === "claim_gallery_notifications") return { data: [
      { id: "ok-id", notification_type: "selection_submitted", recipient_email: "owner@example.test", gallery_title: "Ensaio", client_name: "Cliente", selected_count: 2, tenant_id: "t", gallery_id: "g", attempts: 1 },
      { id: "retry-id", notification_type: "selection_revision_requested", recipient_email: "client@example.test", gallery_title: "Ensaio", client_name: "Cliente", selected_count: 2, message: "Ajustar", attempts: 2 },
    ], error: null };
    return { data: true, error: null };
  } };
  const sent = [];
  const transport = { async sendMail(message) {
    if (message.to === "client@example.test") throw new Error("private SMTP diagnostic");
    sent.push(message);
  } };
  const summary = await deliverGalleryNotifications({ client, transport, from: "Cartlio <mail@local.test>" });
  assert.deepEqual(summary, { examined: 2, sent: 1, retry: 1, failed: 0, pruned: 0 });
  assert.equal(sent[0].messageId, "<ok-id@cartlio>");
  assert.deepEqual(calls.filter(([name]) => name === "finish_gallery_notification").map(([, args]) => [args.p_id, args.p_success, args.p_error_code]), [
    ["ok-id", true, null], ["retry-id", false, "smtp_send_failed"],
  ]);
  assert.equal(JSON.stringify(calls).includes("private SMTP diagnostic"), false);
});

test("delivery can limit claims to one gallery share", async () => {
  let claimArguments;
  const client = { async rpc(name, args) {
    if (name === "claim_gallery_notifications") {
      claimArguments = args;
      return { data: [], error: null };
    }
    return { data: 0, error: null };
  } };
  const summary = await deliverGalleryNotifications({
    client, transport: { async sendMail() {} }, from: "Cartlio <mail@local.test>", shareId: "share-id",
  });

  assert.deepEqual(claimArguments, { p_limit: 10, p_share_id: "share-id", p_token: null });
  assert.equal(summary.examined, 0);
});

test("delivery rejects malformed recipient addresses without calling SMTP", async () => {
  let sent = false;
  const client = { async rpc(name) {
    if (name === "prune_gallery_notification_outbox") return { data: 0, error: null };
    if (name === "claim_gallery_notifications") return { data: [{
      id: "bad-id", notification_type: "selection_submitted", recipient_email: "bad\r\n@example.test",
      gallery_title: "Ensaio", client_name: "Cliente", selected_count: 1, attempts: 1,
    }], error: null };
    return { data: true, error: null };
  } };
  const summary = await deliverGalleryNotifications({
    client, from: "Cartlio <mail@local.test>", transport: { async sendMail() { sent = true; } },
  });
  assert.equal(sent, false);
  assert.equal(summary.retry, 1);
});
