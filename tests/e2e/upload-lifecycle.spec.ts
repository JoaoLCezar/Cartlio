import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { cleanupTenantStorage } from "./support/storage-cleanup.mjs";

const local = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
  encoding: "utf8", shell: process.platform === "win32",
}).replace(/^\uFEFF/, "")) as { API_URL: string; PUBLISHABLE_KEY: string; SERVICE_ROLE_KEY: string };
const admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const slotBytes = 50 * 1024 * 1024;

test("recovers uploads, serializes quota reservations, and cleans only expired sessions", async ({ page }) => {
  test.setTimeout(180_000);
  const suffix = crypto.randomUUID();
  const email = `uploads-${suffix}@cartlio.test`;
  const password = `Uploads-${suffix}-Pass!`;
  const userIds: string[] = [];
  let tenantId: string | undefined;
  try {
    for (const address of [email, `other-${email}`]) {
      const created = await admin.auth.admin.createUser({ email: address, password, email_confirm: true });
      expect(created.error).toBeNull();
      userIds.push(created.data.user!.id);
    }
    const member = createClient(local.API_URL, local.PUBLISHABLE_KEY, { auth: { persistSession: false } });
    const outsider = createClient(local.API_URL, local.PUBLISHABLE_KEY, { auth: { persistSession: false } });
    expect((await member.auth.signInWithPassword({ email, password })).error).toBeNull();
    expect((await outsider.auth.signInWithPassword({ email: `other-${email}`, password })).error).toBeNull();
    const workspace = await member.rpc("create_workspace", { p_name: "Uploads automatizados", p_slug: `uploads-${suffix}` });
    expect(workspace.error).toBeNull();
    tenantId = workspace.data as string;
    const gallery = await member.from("galleries").insert({ tenant_id: tenantId, title: "Ciclo de upload", slug: "ciclo" }).select("id").single();
    expect(gallery.error).toBeNull();
    const galleryId = gallery.data!.id as string;
    const scope = (id: string) => ({ p_tenant_id: tenantId, p_gallery_id: galleryId, p_upload_id: id });
    const reserve = (id: string, filename: string, bytes: number) => member.rpc("reserve_photo_upload", {
      ...scope(id), p_filename: filename, p_content_type: "image/png", p_byte_size: bytes,
    });
    const usage = async () => {
      const result = await member.rpc("workspace_storage_usage", { p_tenant_id: tenantId });
      expect(result.error).toBeNull();
      return result.data as { used_bytes: number; reserved_bytes: number };
    };
    await page.goto("/login");
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL("**/painel");
    await page.goto(`/painel/${tenantId}/galerias/${galleryId}`);
    const buffer = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 2; canvas.height = 2;
      const context = canvas.getContext("2d")!; context.fillStyle = "#a06320"; context.fillRect(0, 0, 2, 2);
      return canvas.toDataURL("image/png").split(",")[1];
    }), "base64");
    const file = (name: string) => ({ name, mimeType: "image/png", buffer });

    // Loss before storage succeeds: durable reservation remains after reload.
    const objectRoute = `${local.API_URL}/storage/v1/object/gallery-originals/**`;
    await page.route(objectRoute, route => route.request().method() === "POST"
      ? route.fulfill({ status: 503, contentType: "application/json", body: '{"message":"Injected outage"}' })
      : route.continue());
    await page.getByLabel("Adicionar imagens").setInputFiles(file("retomada.png"));
    await page.getByRole("button", { name: "Enviar imagens", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Envios pendentes", exact: true })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "Não foi possível concluir o envio" })).toBeVisible();
    await page.unroute(objectRoute);
    expect(await usage()).toMatchObject({ used_bytes: 0, reserved_bytes: slotBytes });
    await page.reload();
    await expect(page.getByLabel("Reenviar retomada.png", { exact: true })).toBeEnabled();
    await page.getByLabel("Reenviar retomada.png", { exact: true }).setInputFiles(file("retomada.png"));
    await expect(page.getByRole("status").filter({ hasText: "Envio de “retomada.png” concluído." })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Envios pendentes", exact: true })).toHaveCount(0);
    expect(await usage()).toMatchObject({ used_bytes: buffer.length, reserved_bytes: 0 });
    const first = await admin.from("upload_sessions").select("id").eq("tenant_id", tenantId).eq("original_filename", "retomada.png").single();
    expect((await member.rpc("complete_photo_upload", scope(first.data!.id))).error).toBeNull();
    expect((await admin.from("photos").select("id").eq("tenant_id", tenantId)).data).toHaveLength(1);

    // Loss after object upload: confirmation recovers without reuploading bytes.
    const confirmationRoute = `${local.API_URL}/rest/v1/rpc/complete_photo_upload`;
    await page.route(confirmationRoute, route => route.fulfill({ status: 503, contentType: "application/json", body: '{"message":"Injected confirmation outage"}' }));
    await page.getByLabel("Adicionar imagens").setInputFiles(file("confirmacao.png"));
    await page.getByRole("button", { name: "Enviar imagens", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Envios pendentes", exact: true })).toBeVisible();
    await page.unroute(confirmationRoute);
    await page.reload();
    await page.getByRole("button", { name: "Confirmar envio confirmacao.png", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Envio de “confirmacao.png” concluído." })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Envios pendentes", exact: true })).toHaveCount(0);
    const processImages = () => JSON.parse(execFileSync(process.execPath, ["scripts/process-images.mjs", "--local", "--tenant", tenantId!], { encoding: "utf8" }));
    expect(processImages()).toMatchObject({ invalid: 0, retry: 0, failed: 0 });
    await page.reload();
    const photo = page.getByRole("img", { name: "confirmacao.png", exact: true });
    await photo.scrollIntoViewIfNeeded();
    await expect.poll(() => photo.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const confirmed = await admin.from("photos").select("id, processing_status").eq("tenant_id", tenantId).eq("original_filename", "confirmacao.png").single();
    expect(confirmed.data?.processing_status).toBe("ready");
    const derivedPath = `${tenantId}/${galleryId}/${confirmed.data!.id}.webp`;
    for (const bucket of ["gallery-previews", "gallery-thumbnails"]) {
      const derived = await admin.storage.from(bucket).download(derivedPath);
      expect(derived.error).toBeNull();
      expect((await sharp(Buffer.from(await derived.data!.arrayBuffer())).metadata()).format).toBe("webp");
      expect((await outsider.storage.from(bucket).download(derivedPath)).error).not.toBeNull();
    }
    expect(await usage()).toMatchObject({ used_bytes: buffer.length * 2, reserved_bytes: 0 });

    // Two requests compete for one slot; one succeeds and one is rejected.
    expect((await admin.from("tenants").update({ storage_limit_bytes: buffer.length * 2 + slotBytes }).eq("id", tenantId)).error).toBeNull();
    const candidates = [crypto.randomUUID(), crypto.randomUUID()];
    const attempts = await Promise.all(candidates.map((id, index) => reserve(id, `concorrente-${index}.png`, buffer.length)));
    expect(attempts.filter(result => !result.error)).toHaveLength(1);
    expect(attempts.find(result => result.error)?.error?.message).toContain("STORAGE_QUOTA_EXCEEDED");
    const winner = attempts.find(result => !result.error)!.data;
    expect((await reserve(winner.id, winner.original_filename, buffer.length)).error).toBeNull();
    expect((await usage()).reserved_bytes).toBe(slotBytes);
    expect((await member.storage.from("gallery-originals").upload(`${tenantId}/${galleryId}/${crypto.randomUUID()}.png`, buffer, { contentType: "image/png" })).error).not.toBeNull();
    expect((await outsider.from("upload_sessions").select("id").eq("tenant_id", tenantId)).data).toEqual([]);
    expect((await outsider.rpc("complete_photo_upload", scope(winner.id))).error?.code).toBe("42501");
    expect((await outsider.rpc("begin_upload_cancellation", scope(winner.id))).error?.code).toBe("42501");
    expect((await outsider.storage.from("gallery-originals").upload(winner.object_path, buffer, { contentType: "image/png" })).error).not.toBeNull();
    await page.reload();
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: `Descartar envio ${winner.original_filename}`, exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: `Envio de “${winner.original_filename}” descartado.` })).toBeVisible();
    expect((await usage()).reserved_bytes).toBe(0);

    expect((await reserve(winner.id, winner.original_filename, buffer.length)).error?.message).toContain("UPLOAD_CLOSED");
    expect((await member.storage.from("gallery-originals").upload(winner.object_path, buffer, { contentType: "image/png" })).error).not.toBeNull();

    // Local reconciler cleans expired sessions, leaving current uploads and photos.
    expect((await admin.from("tenants").update({ storage_limit_bytes: 1073741824 }).eq("id", tenantId)).error).toBeNull();
    const empty = await reserve(crypto.randomUUID(), "vazio.png", buffer.length);
    const expired = await reserve(crypto.randomUUID(), "vencido.png", buffer.length);
    const active = await reserve(crypto.randomUUID(), "ativo.png", buffer.length);
    for (const result of [empty, expired, active]) expect(result.error).toBeNull();
    expect((await member.storage.from("gallery-originals").upload(expired.data.object_path, buffer, { contentType: "image/png" })).error).toBeNull();
    expect((await admin.from("upload_sessions").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).in("id", [empty.data.id, expired.data.id])).error).toBeNull();
    const reconcile = () => JSON.parse(execFileSync(process.execPath, ["scripts/reconcile-uploads.mjs", "--local", "--tenant", tenantId!], { encoding: "utf8" }));
    expect(reconcile()).toEqual({ examined: 2, cleaned: 2, failed: 0 });
    expect(reconcile()).toEqual({ examined: 0, cleaned: 0, failed: 0 });
    expect((await admin.storage.from("gallery-originals").download(expired.data.object_path)).error).not.toBeNull();
    expect(await usage()).toMatchObject({ used_bytes: buffer.length * 2, reserved_bytes: slotBytes });
    expect((await member.rpc("complete_photo_upload", scope(expired.data.id))).error?.message).toContain("UPLOAD_CLOSED");
    expect((await member.rpc("begin_upload_cancellation", scope(active.data.id))).error).toBeNull();
    expect((await member.rpc("finish_upload_cancellation", scope(active.data.id))).data).toBe(true);

    // Stored object size is checked by the server, not trusted from the browser.
    const mismatched = await reserve(crypto.randomUUID(), "incompativel.png", buffer.length + 1);
    expect(mismatched.error).toBeNull();
    expect((await member.storage.from("gallery-originals").upload(mismatched.data.object_path, buffer, { contentType: "image/png" })).error).toBeNull();
    expect((await member.rpc("complete_photo_upload", scope(mismatched.data.id))).error?.message).toContain("UPLOAD_MISMATCH");
    await page.reload();
    await page.getByRole("button", { name: "Confirmar envio incompativel.png", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "não corresponde ao tamanho ou tipo reservado" })).toBeVisible();
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Descartar envio incompativel.png", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Envio de “incompativel.png” descartado." })).toBeVisible();
    expect((await usage()).reserved_bytes).toBe(0);

    // A forged image signature can reach Storage; full decoding rejects it.
    const corrupt = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const invalid = await reserve(crypto.randomUUID(), "corrompida.png", corrupt.length);
    expect(invalid.error).toBeNull();
    expect((await member.storage.from("gallery-originals").upload(invalid.data.object_path, corrupt, { contentType: "image/png" })).error).toBeNull();
    expect((await member.rpc("complete_photo_upload", scope(invalid.data.id))).error).toBeNull();
    expect(processImages()).toMatchObject({ failed: 0 });
    await expect.poll(async () => (await admin.from("photos").select("processing_status").eq("id", invalid.data.id).single()).data?.processing_status).toBe("invalid");
    await page.reload();
    await expect(page.getByText("Arquivo inválido. Exclua e envie outra imagem.", { exact: true })).toBeVisible();

    const archived = await reserve(crypto.randomUUID(), "arquivada.png", buffer.length);
    expect(archived.error).toBeNull();
    expect((await member.storage.from("gallery-originals").upload(archived.data.object_path, buffer, { contentType: "image/png" })).error).toBeNull();
    expect((await member.from("galleries").update({ status: "archived" }).eq("id", galleryId)).error).toBeNull();
    expect((await member.rpc("complete_photo_upload", scope(archived.data.id))).error?.message).toContain("GALLERY_ARCHIVED");
    expect((await reserve(crypto.randomUUID(), "novo.png", buffer.length)).error?.message).toContain("GALLERY_ARCHIVED");
    await page.reload();
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Descartar envio arquivada.png", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Envio de “arquivada.png” descartado." })).toBeVisible();
    expect((await usage()).reserved_bytes).toBe(0);
  } finally {
    if (tenantId) {
      await cleanupTenantStorage(admin, tenantId);
      expect((await admin.from("tenants").delete().eq("id", tenantId)).error).toBeNull();
    }
    for (const id of userIds) expect((await admin.auth.admin.deleteUser(id)).error).toBeNull();
  }
});
