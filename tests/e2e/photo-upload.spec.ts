import { quadricsEnv } from "../../scripts/lib/quadrics-env.mjs";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomFillSync } from "node:crypto";
import sharp from "sharp";
import { cleanupTenantStorage } from "./support/storage-cleanup.mjs";

const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
  encoding: "utf8",
  shell: process.platform === "win32",
}).replace(/^\uFEFF/, "")) as {
  API_URL: string;
  PUBLISHABLE_KEY: string;
  SERVICE_ROLE_KEY: string;
};
const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3310";
const localImageWorker = quadricsEnv("DEV_IMAGE_WORKER") === "1";
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const emailA = `photos-a-${suffix}@cartlio.test`;
const emailB = `photos-b-${suffix}@cartlio.test`;
const password = `Photos-${suffix}-Pass!`;
const browserImage = async (page: Page, mimeType: "image/png" | "image/jpeg") => page.evaluate(type => {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas não disponível.");
  context.fillStyle = "#bf8b35";
  context.fillRect(0, 0, 2, 2);
  return canvas.toDataURL(type).split(",")[1];
}, mimeType).then(value => Buffer.from(value, "base64"));
const largeBrowserImage = async () => {
  const width = 1536;
  const height = 1536;
  const pixels = Buffer.alloc(width * height * 3);
  randomFillSync(pixels);
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
};
const runImageWorker = (tenantId: string) => spawnSync(process.execPath, [
  "scripts/process-images.mjs", "--local", "--tenant", tenantId,
], { encoding: "utf8" });

async function checkPublicPortfolio(page: Page, tenantId: string, slug: string) {
  const browser = page.context().browser();
  if (!browser) throw new Error("O navegador de teste não está disponível.");
  const mobile = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const visitor = await mobile.newPage();
    const publicPath = `/fotografo/${slug}`;
    const { data: photos, error } = await admin.from("photos").select("id,original_filename").eq("tenant_id", tenantId);
    expect(error).toBeNull();
    const selected = photos?.find(photo => photo.original_filename === "ensaio.png");
    const excluded = photos?.find(photo => photo.original_filename === "ensaio.jpg");
    expect(selected).toBeDefined();
    expect(excluded).toBeDefined();
    const selectedPath = `${publicPath}/imagem/${selected!.id}`;
    const excludedPath = `${publicPath}/imagem/${excluded!.id}`;

    await page.getByRole("link", { name: "Portfólio", exact: true }).click();
    await page.getByLabel("Nome público", { exact: true }).fill("Estúdio em portfólio");
    await page.getByRole("button", { name: "Salvar portfólio", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Rascunho salvo" })).toBeVisible();
    expect((await visitor.request.get(selectedPath)).status()).toBe(404);

    await page.getByRole("listitem").filter({ hasText: "ensaio.png" }).getByRole("button", { name: "Adicionar" }).click();
    await expect(page.getByRole("heading", { name: "Fotos selecionadas (1/12)" })).toBeVisible();
    expect((await visitor.request.get(selectedPath)).status()).toBe(404);
    await page.getByRole("checkbox", { name: "Disponibilizar o portfólio ao público" }).check();
    await page.getByRole("button", { name: "Salvar portfólio", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Portfólio publicado." })).toBeVisible();

    await visitor.goto(publicPath);
    await expect(visitor.getByRole("heading", { name: "Estúdio em portfólio" })).toBeVisible();
    await expect(visitor.getByRole("img", { name: "Foto de capa do portfólio" })).toBeVisible();
    const publicImage = await visitor.request.get(selectedPath);
    expect(publicImage.status()).toBe(200);
    expect(publicImage.headers()["content-type"]).toContain("image/webp");
    expect((await visitor.request.get(excludedPath)).status()).toBe(404);

    await page.getByRole("checkbox", { name: "Disponibilizar o portfólio ao público" }).uncheck();
    await page.getByRole("button", { name: "Salvar portfólio", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Rascunho salvo" })).toBeVisible();
    expect((await visitor.request.get(selectedPath)).status()).toBe(404);

    await page.getByRole("button", { name: "Remover", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Fotos selecionadas (0/12)" })).toBeVisible();
    await page.getByRole("checkbox", { name: "Disponibilizar o portfólio ao público" }).check();
    await page.getByRole("button", { name: "Salvar portfólio", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Portfólio publicado." })).toBeVisible();
    expect((await visitor.request.get(selectedPath)).status()).toBe(404);
  } finally {
    await mobile.close();
  }
}

test("uploads private photos, recovers interrupted deletion, and isolates workspaces", async ({ page, request }) => {
  test.setTimeout(180_000);
  let tenantId: string | undefined;
  let galleryId: string | undefined;

  try {
    await page.goto("/cadastro");
    await page.getByLabel("E-mail", { exact: true }).fill(emailA);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Criar conta", exact: true }).click();
    await page.waitForURL("**/painel");

    const { data: listed, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    expect(listError).toBeNull();
    const userA = listed.users.find(user => user.email === emailA);
    expect(userA).toBeDefined();

    await page.getByLabel("Como podemos chamar você?").fill("Fotógrafa de teste");
    await page.getByRole("button", { name: "Salvar perfil", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Perfil salvo." })).toBeVisible();
    await page.getByLabel("Nome do estúdio").fill("Estúdio de fotos automatizado");
    await page.getByLabel("Endereço do workspace").fill(`fotos-${suffix}`);
    await page.getByRole("button", { name: "Criar workspace", exact: true }).click();
    await page.waitForURL(/\/painel\/[0-9a-f-]+$/);
    tenantId = new URL(page.url()).pathname.split("/").at(-1);
    expect(tenantId).toBeTruthy();
    const storageSection = page.getByRole("region", { name: "Armazenamento do workspace" });
    await expect(storageSection).toBeVisible();
    await expect(storageSection).toContainText("1.0 GiB");
    await expect(storageSection.getByRole("meter", { name: "Espaço utilizado e reservado" })).toHaveAttribute("max", "1073741824");

    await page.getByRole("link", { name: "Criar galeria", exact: true }).click();
    const galleryTitle = page.getByLabel("Título", { exact: true });
    const gallerySlug = page.getByLabel("Identificador da galeria", { exact: true });
    await galleryTitle.fill("Ensaio com fotos privadas São João");
    await expect(gallerySlug).toHaveValue("ensaio-com-fotos-privadas-sao-joao");
    await galleryTitle.fill("Ensaio com fotos privadas São João - teste");
    await expect(gallerySlug).toHaveValue("ensaio-com-fotos-privadas-sao-joao-teste");
    await gallerySlug.fill(`ensaio-${suffix}`);
    await galleryTitle.fill("Outro título, identificador preservado");
    await expect(gallerySlug).toHaveValue(`ensaio-${suffix}`);
    await page.getByRole("button", { name: "Gerar identificador pelo título" }).click();
    await expect(gallerySlug).toHaveValue("outro-titulo-identificador-preservado");
    await page.getByRole("button", { name: "Criar galeria", exact: true }).click();
    await page.waitForURL(/\/galerias\/[0-9a-f-]+$/);
    galleryId = new URL(page.url()).pathname.split("/").at(-1);
    expect(galleryId).toBeTruthy();

    const upload = page.locator('input[type="file"]');
    await upload.setInputFiles([
      { name: "ensaio.png", mimeType: "image/png", buffer: await browserImage(page, "image/png") },
      { name: "ensaio.jpg", mimeType: "image/jpeg", buffer: await browserImage(page, "image/jpeg") },
    ]);
    await page.getByRole("button", { name: "Enviar imagens", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "2 imagens enviadas." })).toBeVisible();
    if (localImageWorker) {
      await expect(page.getByRole("img", { name: "ensaio.png", exact: true })).toBeVisible({ timeout: 45_000 });
    } else {
      const processed = runImageWorker(tenantId!);
      expect(processed.status, processed.stderr).toBe(0);
      expect(JSON.parse(processed.stdout)).toMatchObject({ invalid: 0, retry: 0, failed: 0 });
      await page.reload();
    }
    await expect(page.getByRole("img", { name: "ensaio.png", exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole("img", { name: "ensaio.jpg", exact: true })).toBeVisible({ timeout: 45_000 });

    const panelOriginalPhoto = await admin.from("photos").select("id, byte_size")
      .eq("tenant_id", tenantId!).eq("gallery_id", galleryId!).eq("original_filename", "ensaio.png").single();
    expect(panelOriginalPhoto.error).toBeNull();
    const panelOriginalUrl = `/painel/${tenantId}/galerias/${galleryId}/fotos/${panelOriginalPhoto.data!.id}/original`;
    await expect(page.getByRole("link", { name: "Baixar original ensaio.png", exact: true }))
      .toHaveAttribute("href", panelOriginalUrl);
    const panelOriginal = await page.request.get(panelOriginalUrl);
    expect(panelOriginal.status()).toBe(200);
    expect(panelOriginal.headers()["content-type"]).toContain("image/png");
    expect((await panelOriginal.body()).length).toBe(panelOriginalPhoto.data!.byte_size);

    await checkPublicPortfolio(page, tenantId!, `fotos-${suffix}`);
    await page.goto(`/painel/${tenantId}/galerias/${galleryId}`);

    const extraPhotoIds = Array.from({ length: 65 }, () => crypto.randomUUID());
    const extraPhotos = extraPhotoIds.map((photoId, index) => ({
      id: photoId,
      tenant_id: tenantId!,
      gallery_id: galleryId!,
      object_path: `${tenantId}/${galleryId}/${photoId}.png`,
      original_filename: `pagina-${String(index + 1).padStart(2, "0")}.png`,
      content_type: "image/png" as const,
      byte_size: 128,
      created_by: userA!.id,
      processing_status: "failed" as const,
      processing_attempts: 5,
      sort_order: 100_000,
    }));
    const insertedExtraPhotos = await admin.from("photos").insert(extraPhotos);
    expect(insertedExtraPhotos.error).toBeNull();
    const movedReadyPhoto = await admin.from("photos").update({ sort_order: 100_001 })
      .eq("tenant_id", tenantId!).eq("gallery_id", galleryId!).eq("original_filename", "ensaio.png").select("id").single();
    expect(movedReadyPhoto.error).toBeNull();
    await page.reload();
    await expect(page.getByTestId("gallery-photo-card")).toHaveCount(60);
    await expect(page.getByText("Exibindo 60 de 67 fotos.", { exact: true })).toBeVisible();
    const selectedIdsResponse = page.waitForResponse(response => response.request().method() === "GET"
      && response.url().includes(`/painel/${tenantId}/galerias/${galleryId}/fotos?ids=1&offset=0`));
    await page.getByRole("checkbox", { name: "Selecionar todas" }).check();
    const selectedIds = await (await selectedIdsResponse).json() as { ids: string[]; totalCount: number };
    expect(selectedIds).toMatchObject({ totalCount: 67 });
    expect(selectedIds.ids).toHaveLength(67);
    await expect(page.getByRole("button", { name: "Excluir 67 selecionadas", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Limpar seleção", exact: true }).click();
    const nextPhotoPageResponse = page.waitForResponse(response => response.request().method() === "GET"
      && response.url().includes(`/painel/${tenantId}/galerias/${galleryId}/fotos?offset=60`));
    await page.getByRole("button", { name: "Carregar mais fotos" }).click();
    const nextPhotoPage = await (await nextPhotoPageResponse).json() as { photos: unknown[]; totalCount: number | null };
    expect(nextPhotoPage.photos).toHaveLength(7);
    expect(nextPhotoPage.totalCount).toBeNull();
    await expect(page.getByTestId("gallery-photo-card")).toHaveCount(67);
    await expect(page.getByRole("img", { name: "ensaio.png", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Carregar mais fotos" })).toHaveCount(0);
    const restoredPhotoOrder = await admin.from("photos").update({ sort_order: 0 }).eq("id", movedReadyPhoto.data!.id);
    expect(restoredPhotoOrder.error).toBeNull();
    const removedExtraPhotos = await admin.from("photos").delete().eq("tenant_id", tenantId!).in("id", extraPhotoIds);
    expect(removedExtraPhotos.error).toBeNull();
    await page.reload();
    await expect(page.getByTestId("gallery-photo-card")).toHaveCount(2);

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const layout = await page.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth,
      }));
      expect(layout.contentWidth, `editor at ${width}px should not scroll horizontally`).toBeLessThanOrEqual(layout.viewportWidth);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel("Adicionar imagens")).toBeVisible();
    await expect(page.getByRole("button", { name: "Enviar imagens", exact: true })).toBeVisible();

    const largeImage = await largeBrowserImage();
    expect(largeImage.length).toBeGreaterThan(6 * 1024 * 1024);
    const tusRequest = page.waitForRequest(request => request.method() === "POST" && request.url().includes("/storage/v1/upload/resumable"));
    await upload.setInputFiles({ name: "original-grande.png", mimeType: "image/png", buffer: largeImage });
    await page.getByRole("button", { name: "Enviar imagens", exact: true }).click();
    await tusRequest;
    await expect(page.getByRole("status").filter({ hasText: "1 imagem enviada." })).toBeVisible({ timeout: 45_000 });
    const largePhoto = await admin.from("photos").select("id, byte_size, object_path").eq("tenant_id", tenantId!).eq("gallery_id", galleryId!).eq("original_filename", "original-grande.png").single();
    expect(largePhoto.error).toBeNull();
    expect(largePhoto.data?.byte_size).toBe(largeImage.length);
    const largeObject = await admin.storage.from("gallery-originals").download(largePhoto.data!.object_path);
    expect(largeObject.error).toBeNull();
    expect(Buffer.from(await largeObject.data!.arrayBuffer()).equals(largeImage)).toBe(true);
    if (localImageWorker) {
      await expect(page.getByRole("img", { name: "original-grande.png", exact: true })).toBeVisible({ timeout: 45_000 });
    } else {
      const processed = runImageWorker(tenantId!);
      expect(processed.status, processed.stderr).toBe(0);
      expect(JSON.parse(processed.stdout)).toMatchObject({ invalid: 0, retry: 0, failed: 0 });
      await page.reload();
    }
    await expect(page.getByRole("img", { name: "original-grande.png", exact: true })).toBeVisible({ timeout: 45_000 });

    const retryCandidate = await admin.from("photos").select("id, object_path")
      .eq("tenant_id", tenantId!).eq("gallery_id", galleryId!).eq("original_filename", "ensaio.png").single();
    expect(retryCandidate.error).toBeNull();
    const original = await admin.storage.from("gallery-originals").download(retryCandidate.data!.object_path);
    expect(original.error).toBeNull();
    const originalBytes = Buffer.from(await original.data!.arrayBuffer());
    const removedOriginal = await admin.storage.from("gallery-originals").remove([retryCandidate.data!.object_path]);
    expect(removedOriginal.error).toBeNull();
    const queueRetry = await admin.from("photos").update({
      processing_status: "pending", processing_attempts: 1, processing_started_at: null,
      processing_available_at: null, processing_token: null, processed_at: null, width: null, height: null,
    }).eq("id", retryCandidate.data!.id);
    expect(queueRetry.error).toBeNull();

    if (localImageWorker) {
      await expect.poll(async () => {
        const state = await admin.from("photos").select("processing_status, processing_attempts")
          .eq("id", retryCandidate.data!.id).single();
        return state.data;
      }, { timeout: 45_000 }).toMatchObject({ processing_status: "pending", processing_attempts: 2 });
    } else {
      // A separately running local dev server can claim the same workspace queue.
      const failedAttempt = runImageWorker(tenantId!);
      if (failedAttempt.status === 1) {
        expect(JSON.parse(failedAttempt.stdout)).toMatchObject({ examined: 1, ready: 0, retry: 1, failed: 0 });
      } else {
        expect(failedAttempt.status, failedAttempt.stdout || failedAttempt.stderr).toBe(0);
        await expect.poll(async () => {
          const state = await admin.from("photos").select("processing_status, processing_attempts")
            .eq("id", retryCandidate.data!.id).single();
          return state.data;
        }, { timeout: 45_000 }).toMatchObject({ processing_status: "pending", processing_attempts: 2 });
      }
    }
    const waitingPhoto = await admin.from("photos").select("processing_status, processing_attempts, processing_available_at")
      .eq("id", retryCandidate.data!.id).single();
    expect(waitingPhoto.error).toBeNull();
    expect(waitingPhoto.data).toMatchObject({ processing_status: "pending", processing_attempts: 2 });
    expect(Date.parse(waitingPhoto.data!.processing_available_at!)).toBeGreaterThan(Date.now() + 45_000);

    const restoredOriginal = await admin.storage.from("gallery-originals").upload(
      retryCandidate.data!.object_path, originalBytes, { contentType: "image/png", upsert: true },
    );
    expect(restoredOriginal.error).toBeNull();
    const retryNow = await admin.from("photos").update({ processing_available_at: new Date(0).toISOString() })
      .eq("id", retryCandidate.data!.id);
    expect(retryNow.error).toBeNull();
    if (localImageWorker) {
      await expect.poll(async () => {
        const state = await admin.from("photos").select("processing_status, processing_attempts")
          .eq("id", retryCandidate.data!.id).single();
        return state.data;
      }, { timeout: 45_000 }).toMatchObject({ processing_status: "ready", processing_attempts: 3 });
    } else {
      const recoveredAttempt = runImageWorker(tenantId!);
      expect(recoveredAttempt.status, recoveredAttempt.stderr).toBe(0);
      const recoveredResult = JSON.parse(recoveredAttempt.stdout) as { examined: number; ready: number; retry: number; failed: number };
      if (recoveredResult.examined === 1) {
        expect(recoveredResult).toMatchObject({ ready: 1, retry: 0, failed: 0 });
      } else {
        // A separately running local worker may claim the same photo first.
        expect(recoveredResult.examined).toBe(0);
        await expect.poll(async () => {
          const state = await admin.from("photos").select("processing_status, processing_attempts")
            .eq("id", retryCandidate.data!.id).single();
          return state.data;
        }, { timeout: 45_000 }).toMatchObject({ processing_status: "ready", processing_attempts: 3 });
      }
    }
    const recoveredPhoto = await admin.from("photos").select("processing_status, processing_attempts")
      .eq("id", retryCandidate.data!.id).single();
    expect(recoveredPhoto.error).toBeNull();
    expect(recoveredPhoto.data).toMatchObject({ processing_status: "ready", processing_attempts: 3 });
    await page.reload();
    await expect(page.getByRole("img", { name: "ensaio.png", exact: true })).toBeVisible();

    const failedPhoto = await admin.from("photos").update({ processing_status: "failed", processing_attempts: 5 })
      .eq("tenant_id", tenantId!).eq("gallery_id", galleryId!).eq("original_filename", "ensaio.png");
    expect(failedPhoto.error).toBeNull();
    await page.reload();
    await page.getByRole("button", { name: "Tentar processar ensaio.png novamente" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Novo processamento solicitado para" })).toBeVisible();
    if (localImageWorker) {
      await expect(page.getByRole("img", { name: "ensaio.png", exact: true })).toBeVisible({ timeout: 45_000 });
    } else {
      const retried = runImageWorker(tenantId!);
      expect(retried.status, retried.stderr).toBe(0);
      expect(JSON.parse(retried.stdout)).toMatchObject({ invalid: 0, retry: 0, failed: 0 });
      await page.reload();
    }
    await expect(page.getByRole("img", { name: "ensaio.png", exact: true })).toBeVisible({ timeout: 45_000 });
    await page.reload();
    await expect(page.getByRole("img", { name: "ensaio.png", exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "ensaio.jpg", exact: true })).toBeVisible();

    await upload.setInputFiles({ name: "foto.jpg", mimeType: "image/jpeg", buffer: Buffer.from("<svg><script>alert(1)</script></svg>") });
    await page.getByRole("button", { name: "Enviar imagens", exact: true }).click();
    await expect(page.locator('[role="alert"]').filter({ hasText: "não corresponde a uma imagem JPEG ou PNG" })).toBeVisible();

    const { data: firstPhoto, error: photoError } = await admin.from("photos").select("object_path").eq("tenant_id", tenantId!).eq("gallery_id", galleryId!).limit(1).single();
    expect(photoError).toBeNull();
    if (!firstPhoto) throw new Error("O envio não criou metadados para a primeira foto.");
    const anonymousObject = await request.get(`${status.API_URL}/storage/v1/object/public/gallery-originals/${firstPhoto.object_path}`);
    expect(anonymousObject.ok()).toBeFalsy();

    // Even a member must record intent before deleting a registered original.
    const member = createClient(status.API_URL, status.PUBLISHABLE_KEY, { auth: { persistSession: false } });
    const memberLogin = await member.auth.signInWithPassword({ email: emailA, password });
    expect(memberLogin.error).toBeNull();
    await member.storage.from("gallery-originals").remove([firstPhoto.object_path]);
    const protectedOriginal = await admin.storage.from("gallery-originals").download(firstPhoto.object_path);
    expect(protectedOriginal.error).toBeNull();

    const { data: jpgPhoto, error: jpgError } = await admin.from("photos").select("object_path").eq("tenant_id", tenantId!).eq("gallery_id", galleryId!).eq("original_filename", "ensaio.jpg").single();
    expect(jpgError).toBeNull();
    if (!jpgPhoto) throw new Error("O JPEG de teste não foi registrado.");
    // Cancelling the destructive action must leave both file and metadata intact.
    page.once("dialog", dialog => dialog.dismiss());
    await page.getByRole("button", { name: "Excluir ensaio.jpg", exact: true }).click();
    await expect(page.getByRole("img", { name: "ensaio.jpg", exact: true })).toBeVisible();

    // Storage outage: intent survives reload and the other photo stays usable.
    const storageDeleteURL = `${status.API_URL}/storage/v1/object/gallery-originals`;
    await page.route(storageDeleteURL, route => route.request().method() === "DELETE"
      ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Injected storage outage" }) })
      : route.continue());
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Excluir ensaio.jpg", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "A exclusão ficou pendente." })).toBeVisible();
    await page.unroute(storageDeleteURL);
    const retainedObject = await admin.storage.from("gallery-originals").download(jpgPhoto.object_path);
    expect(retainedObject.error).toBeNull();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Exclusões pendentes", exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "ensaio.png", exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "ensaio.jpg", exact: true })).toHaveCount(0);

    // Storage succeeds but confirmation fails: reload must still allow recovery.
    const finishURL = `${status.API_URL}/rest/v1/rpc/finish_photo_deletion`;
    await page.route(finishURL, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Injected confirmation outage" }) }));
    await page.getByRole("button", { name: "Concluir exclusão ensaio.jpg", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Não foi possível confirmar a exclusão." })).toBeVisible();
    await page.unroute(finishURL);
    const deletedObject = await admin.storage.from("gallery-originals").download(jpgPhoto.object_path);
    expect(deletedObject.error).not.toBeNull();
    const pendingMetadata = await admin.from("photos").select("deletion_requested_at").eq("object_path", jpgPhoto.object_path).single();
    expect(pendingMetadata.error).toBeNull();
    expect(pendingMetadata.data?.deletion_requested_at).toBeTruthy();
    await page.reload();
    await expect(page.getByRole("img", { name: "ensaio.png", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Concluir exclusão ensaio.jpg", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Imagem “ensaio.jpg” excluída." })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Exclusões pendentes", exact: true })).toHaveCount(0);
    const deletedMetadata = await admin.from("photos").select("id").eq("tenant_id", tenantId!).eq("gallery_id", galleryId!).eq("original_filename", "ensaio.jpg");
    expect(deletedMetadata.error).toBeNull();
    expect(deletedMetadata.data).toEqual([]);

    // Legacy inconsistency: one active row without a file must not break the gallery.
    const missingPhotoId = crypto.randomUUID();
    const missingPhoto = await admin.from("photos").insert({
      id: missingPhotoId, tenant_id: tenantId, gallery_id: galleryId,
      object_path: `${tenantId}/${galleryId}/${missingPhotoId}.png`,
      original_filename: "ausente.png", content_type: "image/png", byte_size: 128, created_by: userA!.id, processing_status: "ready",
    });
    expect(missingPhoto.error).toBeNull();
    await page.reload();
    await expect(page.getByText("Imagem indisponível. Tente recarregar a página.", { exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "ensaio.png", exact: true })).toBeVisible();
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Excluir ausente.png", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Imagem “ausente.png” excluída." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Excluir ausente.png", exact: true })).toHaveCount(0);

    const bulkNames = ["rascunho-a.png", "rascunho-b.png"];
    const bulkImage = await browserImage(page, "image/png");
    await upload.setInputFiles(bulkNames.map(name => ({ name, mimeType: "image/png", buffer: bulkImage })));
    await page.getByRole("button", { name: "Enviar imagens", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "2 imagens enviadas." })).toBeVisible();
    if (localImageWorker) {
      for (const name of bulkNames) await expect(page.getByRole("img", { name, exact: true })).toBeVisible({ timeout: 45_000 });
    } else {
      const processed = runImageWorker(tenantId!);
      expect(processed.status, processed.stderr).toBe(0);
      expect(JSON.parse(processed.stdout)).toMatchObject({ invalid: 0, retry: 0, failed: 0 });
      await page.reload();
      for (const name of bulkNames) await expect(page.getByRole("img", { name, exact: true })).toBeVisible({ timeout: 45_000 });
    }
    const bulkPhotos = await admin.from("photos").select("id, object_path")
      .eq("tenant_id", tenantId!).eq("gallery_id", galleryId!).in("original_filename", bulkNames);
    expect(bulkPhotos.error).toBeNull();
    expect(bulkPhotos.data).toHaveLength(2);
    for (const name of bulkNames) await page.getByRole("checkbox", { name: `Selecionar ${name} para exclusão` }).check();
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Excluir 2 selecionadas" }).click();
    await expect(page.getByRole("status").filter({ hasText: "2 imagens excluídas." })).toBeVisible();
    const deletedBulkPhotos = await admin.from("photos").select("id")
      .eq("tenant_id", tenantId!).eq("gallery_id", galleryId!).in("original_filename", bulkNames);
    expect(deletedBulkPhotos.error).toBeNull();
    expect(deletedBulkPhotos.data).toEqual([]);
    for (const photo of bulkPhotos.data!) {
      const deletedBulkObject = await admin.storage.from("gallery-originals").download(photo.object_path);
      expect(deletedBulkObject.error).not.toBeNull();
    }

    await page.locator("select[name=status]").selectOption("published");
    await page.getByRole("button", { name: "Salvar alterações", exact: true }).click();
    await expect(page.getByText("Galeria atualizada.", { exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "ensaio.png", exact: true })).toBeVisible();
    await page.locator("select[name=status]").selectOption("archived");
    await page.getByRole("button", { name: "Salvar alterações", exact: true }).click();
    await expect(page.getByText("A galeria está arquivada. As fotos existentes continuam disponíveis aos membros do workspace.", { exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "ensaio.png", exact: true })).toBeVisible();
    expect(await upload.count()).toBe(0);

    const { error: createBError } = await admin.auth.admin.createUser({ email: emailB, password, email_confirm: true });
    expect(createBError).toBeNull();
    const userB = createClient(status.API_URL, status.PUBLISHABLE_KEY, { auth: { persistSession: false } });
    const { error: signInBError } = await userB.auth.signInWithPassword({ email: emailB, password });
    expect(signInBError).toBeNull();
    const forbiddenUpload = await userB.storage.from("gallery-originals").upload(
      `${tenantId}/${galleryId}/${crypto.randomUUID()}.png`, await browserImage(page, "image/png"), { contentType: "image/png" },
    );
    expect(forbiddenUpload.error).not.toBeNull();
    const forbiddenPhotos = await userB.from("photos").select("id").eq("tenant_id", tenantId!);
    expect(forbiddenPhotos.error).toBeNull();
    expect(forbiddenPhotos.data).toEqual([]);
    const { data: remainingPhotos, error: remainingPhotosError } = await admin.from("photos").select("id, object_path, byte_size").eq("tenant_id", tenantId!).eq("gallery_id", galleryId!);
    expect(remainingPhotosError).toBeNull();
    expect(remainingPhotos).toHaveLength(2);
    const storageUsage = await member.rpc("workspace_storage_usage", { p_tenant_id: tenantId });
    expect(storageUsage.error).toBeNull();
    expect(storageUsage.data).toMatchObject({ used_bytes: remainingPhotos!.reduce((total, photo) => total + photo.byte_size, 0), reserved_bytes: 0 });
    for (const remainingPhoto of remainingPhotos!) {
      const forbiddenDeletion = await userB.rpc("begin_photo_deletion", { p_tenant_id: tenantId, p_gallery_id: galleryId, p_photo_id: remainingPhoto.id });
      expect(forbiddenDeletion.error?.code).toBe("42501");
      const forbiddenCompletion = await userB.rpc("finish_photo_deletion", { p_tenant_id: tenantId, p_gallery_id: galleryId, p_photo_id: remainingPhoto.id });
      expect(forbiddenCompletion.error?.code).toBe("42501");
      // Storage can return an empty result for an unauthorized DELETE; verify the effect.
      await userB.storage.from("gallery-originals").remove([remainingPhoto.object_path]);
      const remainingObject = await admin.storage.from("gallery-originals").download(remainingPhoto.object_path);
      expect(remainingObject.error).toBeNull();
    }

    await page.getByRole("button", { name: "Sair", exact: true }).click();
    await page.waitForURL("**/login");
    await page.getByLabel("E-mail", { exact: true }).fill(emailB);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL("**/painel");
    const denied = await page.goto(`${baseURL}/painel/${tenantId}/galerias/${galleryId}`);
    expect(denied?.status()).not.toBe(500);
    await expect(page.getByRole("heading", { name: "Página não encontrada", exact: true })).toBeVisible();
    await expect(page.getByText("ensaio.png", { exact: true })).toHaveCount(0);
    const deniedPhotoPage = await page.evaluate(async url => {
      const response = await fetch(url);
      return { status: response.status, body: await response.text() };
    }, `${baseURL}/painel/${tenantId}/galerias/${galleryId}/fotos?ids=1&offset=0`);
    expect(deniedPhotoPage.status).toBe(404);
    expect(deniedPhotoPage.body).not.toContain("ensaio.png");
  } finally {
    const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    for (const user of users.users.filter(candidate => candidate.email === emailA || candidate.email === emailB)) {
      const tenants = await admin.from("tenants").select("id").eq("created_by", user.id);
      for (const tenant of tenants.data ?? []) {
        await cleanupTenantStorage(admin, tenant.id);
        const removedTenant = await admin.from("tenants").delete().eq("id", tenant.id);
        expect(removedTenant.error).toBeNull();
      }
      const removedUser = await admin.auth.admin.deleteUser(user.id);
      expect(removedUser.error).toBeNull();
    }
  }
});
