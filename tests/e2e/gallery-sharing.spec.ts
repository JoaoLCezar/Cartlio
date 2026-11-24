import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { cleanupTenantStorage } from "./support/storage-cleanup.mjs";

const local = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
  encoding: "utf8", shell: process.platform === "win32",
}).replace(/^\uFEFF/, "")) as { API_URL: string; PUBLISHABLE_KEY: string; SERVICE_ROLE_KEY: string };
const admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const runNotificationWorker = (shareId: string, port: number) => spawnSync(process.execPath, [
  "scripts/deliver-gallery-notifications.mjs", "--local", "--share", shareId,
], {
  encoding: "utf8",
  env: {
    ...process.env,
    QUADRICS_SMTP_HOST: "127.0.0.1",
    QUADRICS_SMTP_PORT: String(port),
    QUADRICS_SMTP_FROM: "Quadrics <notificacoes@quadrics.local>",
    QUADRICS_SMTP_SECURE: "false",
    QUADRICS_SMTP_USER: "",
    QUADRICS_SMTP_PASSWORD: "",
    QUADRICS_SMTP_REQUIRE_TLS: "false",
  },
});

test("a gallery link serves only ready previews and stops after revocation or expiry", async ({ page, browser, request }) => {
  test.setTimeout(180_000);
  const suffix = crypto.randomUUID();
  const email = `share-${suffix}@cartlio.test`;
  const customerEmail = `cliente-${suffix}@cartlio.test`;
  const customerWhatsAppPhone = "+5511998765432";
  const password = `Share-${suffix}-Pass!`;
  let userId: string | undefined;
  let tenantId: string | undefined;
  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    userId = created.data.user!.id;
    const member = createClient(local.API_URL, local.PUBLISHABLE_KEY, { auth: { persistSession: false } });
    expect((await member.auth.signInWithPassword({ email, password })).error).toBeNull();
    const workspace = await member.rpc("create_workspace", { p_name: "Galeria compartilhada", p_slug: `share-${suffix}` });
    expect(workspace.error).toBeNull();
    tenantId = workspace.data as string;
    const customer = await member.from("customers").insert({ tenant_id: tenantId, name: "Cliente de teste", email: customerEmail, whatsapp_phone: customerWhatsAppPhone }).select("id").single();
    expect(customer.error).toBeNull();
    const gallery = await member.from("galleries").insert({ tenant_id: tenantId, customer_id: customer.data!.id, title: "Ensaio para cliente", description: "Uma seleção para revisar em família.", slug: "ensaio", status: "published" }).select("id").single();
    const other = await member.from("galleries").insert({ tenant_id: tenantId, title: "Outra galeria", slug: "outra", status: "published" }).select("id").single();
    const draft = await member.from("galleries").insert({ tenant_id: tenantId, title: "Rascunho interno", slug: "rascunho", status: "draft" }).select("id").single();
    expect(gallery.error).toBeNull(); expect(other.error).toBeNull(); expect(draft.error).toBeNull();
    const galleryId = gallery.data!.id as string;
    const otherId = other.data!.id as string;
    await page.goto("/login");
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL("**/painel");
    await page.goto(`/painel/${tenantId}`);
    await expect(page.getByText("Adicione fotos para criar a capa").first()).toBeVisible();
    await page.goto(`/painel/${tenantId}/galerias/${galleryId}`);
    const customerPicker = page.getByRole("combobox", { name: "Cliente principal", exact: true });
    await expect(customerPicker).toHaveValue("Cliente de teste");
    await customerPicker.fill("Cliente de t");
    await page.getByRole("listbox").getByRole("button", { name: "Cliente de teste", exact: true }).click();
    await expect(page.locator('input[type="hidden"][name="customer_id"]')).toHaveValue(customer.data!.id);
    await page.getByRole("button", { name: "Salvar alterações", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Galeria atualizada." })).toBeVisible();
    await page.goto(`/painel/${tenantId}/galerias/${otherId}`);
    await expect(page.getByRole("button", { name: "Criar link" })).toBeDisabled();
    await expect(page.getByText("Processe pelo menos uma foto antes de criar um link para o cliente.")).toBeVisible();
    const emptyGalleryShare = await member.rpc("create_gallery_share", {
      p_tenant_id: tenantId,
      p_gallery_id: otherId,
      p_expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      p_selection_limit: 10,
      p_share_mode: "selection",
      p_pin: null,
    });
    expect(emptyGalleryShare.error?.message).toContain("SHARE_NO_READY_PHOTOS");
    await page.goto(`/painel/${tenantId}/marca`);
    await expect(page.getByRole("heading", { name: "Marca do estúdio" })).toBeVisible();
    await page.getByLabel("Nome público do estúdio").fill("Aurora Fotografia");
    await page.getByLabel("Cor de destaque").fill("#4a8068");
    const brandPreview = page.getByRole("region", { name: "Prévia da galeria compartilhada" });
    await expect(brandPreview.locator(".gallery-public-studio")).toHaveText("Aurora Fotografia");
    await expect(brandPreview.locator(".gallery-public-studio")).toHaveCSS("background-color", "rgb(74, 128, 104)");
    const logoBuffer = await sharp({
      create: { width: 24, height: 12, channels: 4, background: "#4a8068" },
    }).png().toBuffer();
    await page.getByLabel("Escolha uma imagem").setInputFiles({
      name: "aurora-logo.png",
      mimeType: "image/png",
      buffer: logoBuffer,
    });
    await expect(brandPreview.getByRole("img", { name: "Logo de Aurora Fotografia" })).toBeVisible();
    await page.getByRole("button", { name: "Enviar logo" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Logo do estúdio atualizado." })).toBeVisible();
    await page.getByRole("button", { name: "Salvar identidade" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Identidade do estúdio atualizada." })).toBeVisible();
    await page.goto(`/painel/${tenantId}`);
    await expect(page.getByRole("progressbar", { name: "Etapas da primeira entrega" })).toHaveAttribute("value", "1");
    await page.getByLabel("Buscar por título").fill("Ensaio");
    await page.getByLabel("Status").selectOption("published");
    await page.getByRole("button", { name: "Filtrar", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Ensaio para cliente", level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Outra galeria", level: 2 })).toHaveCount(0);
    await page.getByRole("link", { name: "Limpar", exact: true }).click();
    await expect(page.getByLabel("Buscar por título")).toHaveValue("");
    await expect(page.getByLabel("Status")).toHaveValue("all");
    await page.getByLabel("Status").selectOption("draft");
    await page.getByRole("button", { name: "Filtrar", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Rascunho interno" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ensaio para cliente" })).toHaveCount(0);
    await page.getByLabel("Buscar por título").fill("galeria inexistente");
    await page.getByLabel("Status").selectOption("all");
    await page.getByRole("button", { name: "Filtrar", exact: true }).click();
    await expect(page.getByText("Nenhuma galeria encontrada com estes filtros.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Organize seu primeiro trabalho" })).toHaveCount(0);
    const buffer = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 2; canvas.height = 2;
      const context = canvas.getContext("2d")!; context.fillStyle = "#9c5426"; context.fillRect(0, 0, 2, 2);
      return canvas.toDataURL("image/png").split(",")[1];
    }), "base64");
    async function upload(galleryScope: string, filename: string) {
      const id = crypto.randomUUID();
      const scope = { p_tenant_id: tenantId, p_gallery_id: galleryScope, p_upload_id: id };
      const reserved = await member.rpc("reserve_photo_upload", { ...scope, p_filename: filename, p_content_type: "image/png", p_byte_size: buffer.length });
      expect(reserved.error).toBeNull();
      expect((await member.storage.from("gallery-originals").upload(reserved.data.object_path, buffer, { contentType: "image/png" })).error).toBeNull();
      expect((await member.rpc("complete_photo_upload", scope)).error).toBeNull();
      return id;
    }
    const readyId = await upload(galleryId, "pronta.png");
    const secondId = await upload(galleryId, "segunda.png");
    const otherPhotoId = await upload(otherId, "outra.png");
    const processed = JSON.parse(execFileSync(process.execPath, ["scripts/process-images.mjs", "--local", "--tenant", tenantId], { encoding: "utf8" }));
    expect(processed).toMatchObject({ invalid: 0, retry: 0, failed: 0 });
    const readyPhotos = await member.from("photos").select("id").in("id", [readyId, secondId, otherPhotoId]).eq("processing_status", "ready");
    expect(readyPhotos.error).toBeNull();
    await expect.poll(async () => {
      const result = await member.from("photos").select("id").in("id", [readyId, secondId, otherPhotoId]).eq("processing_status", "ready");
      expect(result.error).toBeNull();
      return result.data?.length ?? 0;
    }, { timeout: 30_000 }).toBe(3);
    const pendingId = await upload(galleryId, "pendente.png");
    // Keep one non-ready fixture stable even when a developer's background worker is running.
    const heldPhoto = await admin.from("photos").update({
      processing_status: "failed", processing_started_at: null, processing_available_at: null, processing_token: null,
    }).eq("id", pendingId);
    expect(heldPhoto.error).toBeNull();

    await page.goto(`/painel/${tenantId}/galerias/${galleryId}`);
    await expect(page.getByRole("button", { name: "Criar link" })).toBeEnabled();
    const photoIdLookupLimits: string[] = [];
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.searchParams.get("ids") === "1") photoIdLookupLimits.push(url.searchParams.get("limit") ?? "default");
    });
    await page.getByRole("button", { name: "Mover pronta.png para cima" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Ordem das fotos salva" })).toBeVisible();
    expect(photoIdLookupLimits).toEqual(["1"]);
    await expect(page.getByRole("button", { name: "Criar link" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Mover pronta.png para baixo" })).toBeEnabled();
    const secondPhotoCard = page.locator("li").filter({ has: page.getByRole("img", { name: "segunda.png" }) });
    const secondCardBounds = await secondPhotoCard.boundingBox();
    expect(secondCardBounds).not.toBeNull();
    const readyDragHandle = page.getByRole("img", { name: "Alça para reordenar pronta.png" });
    await readyDragHandle.dragTo(secondPhotoCard, { targetPosition: { x: secondCardBounds!.width / 2, y: secondCardBounds!.height - 8 } });
    await expect.poll(async () => {
      const order = await member.from("photos").select("id, sort_order").in("id", [readyId, secondId]).order("sort_order");
      expect(order.error).toBeNull();
      return order.data?.map(photo => photo.id);
    }).toEqual([secondId, readyId]);
    await expect(page.getByRole("status").filter({ hasText: "Ordem das fotos salva" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Mover segunda.png para baixo" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Criar link" })).toBeEnabled();
    const secondCardBoundsAfterDrop = await secondPhotoCard.boundingBox();
    expect(secondCardBoundsAfterDrop).not.toBeNull();
    await readyDragHandle.dragTo(secondPhotoCard, { targetPosition: { x: secondCardBoundsAfterDrop!.width / 2, y: 8 } });
    await expect.poll(async () => {
      const order = await member.from("photos").select("id, sort_order").in("id", [readyId, secondId]).order("sort_order");
      expect(order.error).toBeNull();
      return order.data?.map(photo => photo.id);
    }).toEqual([readyId, secondId]);
    await page.getByRole("button", { name: "Definir segunda.png como capa" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Capa da galeria atualizada" })).toBeVisible();
    await page.goto(`/painel/${tenantId}`);
    const customerFilter = page.getByRole("combobox", { name: "Cliente", exact: true });
    await customerFilter.fill("Cliente de teste");
    await page.getByRole("listbox").getByRole("button", { name: "Cliente de teste", exact: true }).click();
    await page.getByRole("button", { name: "Filtrar", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Ensaio para cliente", level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Outra galeria", level: 2 })).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`customer=${customer.data!.id}`));
    await page.getByRole("button", { name: "Sem cliente vinculado", exact: true }).click();
    await page.getByRole("button", { name: "Filtrar", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Outra galeria", level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ensaio para cliente", level: 2 })).toHaveCount(0);
    await page.getByRole("link", { name: "Limpar", exact: true }).click();
    await expect(page.getByRole("progressbar", { name: "Etapas da primeira entrega" })).toHaveAttribute("value", "2");
    const dashboardCover = page.getByRole("img", { name: "Capa da galeria Ensaio para cliente" });
    await expect(dashboardCover).toBeVisible();
    await expect(dashboardCover).toHaveAttribute("src", new RegExp(secondId));
    await expect.poll(() => dashboardCover.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const galleryCard = page.locator(".gallery-dashboard-card").filter({ has: page.getByRole("heading", { name: "Ensaio para cliente" }) });
    await expect(galleryCard.getByText("1 foto com falha", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    const dashboardMobileLayout = await page.evaluate(() => ({
      viewportWidth: document.documentElement.clientWidth,
      contentWidth: document.documentElement.scrollWidth,
    }));
    expect(dashboardMobileLayout.contentWidth).toBeLessThanOrEqual(dashboardMobileLayout.viewportWidth);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/painel/${tenantId}/galerias/${galleryId}`);
    await page.getByLabel("Limite de escolhas").selectOption("1");
    await page.getByLabel("Validade do link").selectOption("1");
    await page.getByRole("button", { name: "Criar link" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Link criado" })).toBeVisible();
    const url = await page.getByLabel("Novo link").inputValue();
    const token = new URL(url).pathname.split("/").at(-1)!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(url).origin });
    await page.getByRole("button", { name: "Copiar link" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Link copiado" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    const dashboardPage = await page.context().newPage();
    await dashboardPage.goto(`/painel/${tenantId}`);
    await expect(dashboardPage.getByRole("progressbar", { name: "Etapas da primeira entrega" })).toHaveCount(0);
    const expiringLinksPanel = dashboardPage.locator("section").filter({ has: dashboardPage.getByRole("heading", { name: /Links perto do vencimento/ }) });
    await expect(expiringLinksPanel).toContainText("Ensaio para cliente");
    await expect(expiringLinksPanel.getByText("Seleção de fotos", { exact: false })).toBeVisible();
    await expect(expiringLinksPanel.getByRole("link", { name: "Renovar link" })).toHaveAttribute("href", `/painel/${tenantId}/galerias/${galleryId}`);
    await dashboardPage.getByRole("link", { name: "Renovar link" }).click();
    await expect(dashboardPage).toHaveURL(new RegExp(`/painel/${tenantId}/galerias/${galleryId}$`));
    await dashboardPage.close();
    const whatsappShareUrl = new URL((await page.getByRole("link", { name: "Compartilhar pelo WhatsApp" }).getAttribute("href"))!);
    expect(whatsappShareUrl.pathname).toBe("/5511998765432");
    const whatsappMessage = whatsappShareUrl.searchParams.get("text")!;
    expect(whatsappMessage).toContain("Ensaio para cliente");
    expect(whatsappMessage).toContain(url);
    expect(whatsappMessage).not.toContain(customerWhatsAppPhone);
    const shared = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const visitor = await shared.newPage();
      const opened = await visitor.goto(url);
      expect(opened?.status()).toBe(200);
      expect(await opened!.text()).not.toContain(customerWhatsAppPhone);
      expect(await visitor.locator("body").innerText()).not.toContain(customerWhatsAppPhone);
      expect(opened?.headers()["cache-control"]).toContain("no-store");
      expect(opened?.headers()["referrer-policy"]).toBe("no-referrer");
      await expect(visitor.locator('meta[property="og:title"]')).toHaveAttribute("content", "Ensaio para cliente | Aurora Fotografia");
      await expect(visitor.locator('meta[name="description"]')).toHaveAttribute("content", "Uma seleção para revisar em família.");
      const socialImage = await visitor.locator('meta[property="og:image"]').getAttribute("content");
      expect(socialImage).toBeTruthy();
      expect(new URL(socialImage!).origin).toBe(new URL(url).origin);
      expect(new URL(socialImage!).pathname).toBe(`/g/${token}/share-card`);
      const socialImageResponse = await request.get(socialImage!);
      expect(socialImageResponse.status()).toBe(200);
      expect(socialImageResponse.headers()["content-type"]).toContain("image/jpeg");
      expect(socialImageResponse.headers()["cache-control"]).toContain("no-store");
      const socialCardBytes = await socialImageResponse.body();
      const socialCard = await sharp(socialCardBytes).metadata();
      expect(socialCard).toMatchObject({ format: "jpeg", width: 1200, height: 630 });
      const logoRegion = await sharp(socialCardBytes).extract({ left: 950, top: 90, width: 150, height: 60 }).removeAlpha().raw().toBuffer();
      let visibleStudioLogoPixels = 0;
      for (let index = 0; index < logoRegion.length; index += 3) {
        if (logoRegion[index + 1] > logoRegion[index] + 20 && logoRegion[index + 1] > logoRegion[index + 2] + 10) visibleStudioLogoPixels++;
      }
      expect(visibleStudioLogoPixels).toBeGreaterThan(2_000);
      const coverPhoto = visitor.locator(".gallery-cover-image");
      await expect(coverPhoto).toBeVisible();
      await expect(coverPhoto).toHaveAttribute("src", new RegExp(secondId));
      await expect.poll(() => coverPhoto.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      const brandLogo = visitor.locator(".gallery-brand-mark");
      await expect(brandLogo).toBeVisible();
      await expect(brandLogo).toHaveAttribute("alt", "Logo de Aurora Fotografia");
      await expect.poll(() => brandLogo.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      expect(await visitor.locator("main").evaluate(element => getComputedStyle(element).getPropertyValue("--gallery-brand-color").trim())).toBe("#4a8068");
      await expect(visitor.getByRole("heading", { name: "Ensaio para cliente" })).toBeVisible();
      await expect(visitor.getByRole("link", { name: "Ver galeria" })).toHaveAttribute("href", "#gallery-photos");
      await expect(visitor.getByText("Marque até 1 foto.")).toBeVisible();
      await expect(visitor.getByRole("img", { name: "pronta.png" })).toBeVisible();
      await expect(visitor.getByRole("img", { name: "segunda.png" })).toBeVisible();
      const photoViewer = visitor.getByRole("dialog", { name: "Visualizador de fotos" });
      await visitor.getByRole("button", { name: "Ampliar pronta.png" }).click();
      await expect(photoViewer).toBeVisible();
      await expect(photoViewer.getByRole("heading", { name: "pronta.png" })).toBeVisible();
      await visitor.keyboard.press("ArrowRight");
      await expect(photoViewer.getByRole("heading", { name: "segunda.png" })).toBeVisible();
      await visitor.keyboard.press("ArrowLeft");
      await expect(photoViewer.getByRole("heading", { name: "pronta.png" })).toBeVisible();
      await photoViewer.getByRole("button", { name: "Selecionar pronta.png" }).click();
      await expect(visitor.getByRole("status").filter({ hasText: "Escolha salva." })).toBeVisible();
      await photoViewer.getByLabel("Observação para o fotógrafo").fill("Remover a placa refletida no vidro.");
      await photoViewer.getByRole("button", { name: "Salvar observação" }).click();
      await expect(photoViewer.getByRole("status").filter({ hasText: "Observação salva." })).toBeVisible();
      await visitor.keyboard.press("Escape");
      await expect(photoViewer).toBeHidden();
      await expect(visitor.getByText("1 foto escolhida", { exact: true })).toBeVisible();
      await expect(visitor.getByRole("link", { name: "Ir para envio" })).toBeVisible();
      await visitor.getByRole("link", { name: "Ir para envio" }).click();
      await expect(visitor.getByLabel("Seu nome")).toBeInViewport();
      await expect(visitor.getByRole("button", { name: "Selecionar segunda.png" })).toBeDisabled();
      await visitor.getByRole("button", { name: "Selecionadas (1)" }).click();
      await expect(visitor.getByRole("img", { name: "pronta.png" })).toBeVisible();
      await expect(visitor.getByRole("img", { name: "segunda.png" })).toHaveCount(0);
      await visitor.getByLabel("Buscar pelo nome do arquivo").fill("SEGUNDA");
      await expect(visitor.getByRole("status").filter({ hasText: "Nenhuma foto selecionada corresponde" })).toBeVisible();
      await visitor.getByRole("button", { name: "Ver todas as fotos" }).click();
      await expect(visitor.getByRole("img", { name: "segunda.png" })).toBeVisible();
      await expect(visitor.getByRole("img", { name: "pronta.png" })).toHaveCount(0);
      await visitor.getByRole("button", { name: "Todas as fotos (2)" }).click();
      await visitor.getByLabel("Buscar pelo nome do arquivo").fill("PRÔNTA");
      await expect(visitor.getByRole("img", { name: "pronta.png" })).toBeVisible();
      await expect(visitor.getByRole("img", { name: "segunda.png" })).toHaveCount(0);
      await visitor.getByLabel("Buscar pelo nome do arquivo").fill("arquivo-inexistente");
      await expect(visitor.getByRole("status").filter({ hasText: "Nenhuma foto encontrada" })).toBeVisible();
      await visitor.getByRole("button", { name: "Limpar busca" }).click();
      await expect(visitor.getByRole("img", { name: "segunda.png" })).toBeVisible();
      visitor.once("dialog", dialog => dialog.accept());
      await visitor.getByRole("button", { name: "Limpar sele\u00e7\u00e3o" }).click();
      await expect(visitor.getByRole("status").filter({ hasText: "Sele\u00e7\u00e3o limpa; as observa\u00e7\u00f5es tamb\u00e9m foram removidas." })).toBeVisible();
      await expect(visitor.getByText("0 fotos escolhidas", { exact: true })).toBeVisible();
      await visitor.getByRole("button", { name: "Selecionar pronta.png" }).click();
      await expect(visitor.getByRole("status").filter({ hasText: "Escolha salva." })).toBeVisible();
      await visitor.getByRole("button", { name: "Ampliar pronta.png" }).click();
      await expect(photoViewer.getByLabel("Observa\u00e7\u00e3o para o fot\u00f3grafo")).toHaveValue("");
      await photoViewer.getByLabel("Observa\u00e7\u00e3o para o fot\u00f3grafo").fill("Remover a placa refletida no vidro.");
      await photoViewer.getByRole("button", { name: "Salvar observa\u00e7\u00e3o" }).click();
      await expect(photoViewer.getByRole("status").filter({ hasText: "Observa\u00e7\u00e3o salva." })).toBeVisible();
      await visitor.keyboard.press("Escape");
      await expect(photoViewer).toBeHidden();
      const mobileLayout = await visitor.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth,
      }));
      expect(mobileLayout.contentWidth).toBeLessThanOrEqual(mobileLayout.viewportWidth);
      await visitor.setViewportSize({ width: 320, height: 844 });
      const narrowLayout = await visitor.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth,
      }));
      expect(narrowLayout.contentWidth).toBeLessThanOrEqual(narrowLayout.viewportWidth);
      const displayedPhotos = await visitor.locator('.gallery-photo-card img[alt]:not([alt=""])').evaluateAll(images => images.map(image => image.getAttribute("alt")));
      expect(displayedPhotos.slice(0, 2)).toEqual(["pronta.png", "segunda.png"]);
      await expect(visitor.getByText("pendente.png", { exact: true })).toHaveCount(0);
      await expect(visitor.getByText("outra.png", { exact: true })).toHaveCount(0);
      await expect(visitor.getByRole("link", { name: /Baixar original/ })).toHaveCount(0);
      const thumb = await request.get(`/g/${token}/image/${readyId}?size=thumb`);
      const preview = await request.get(`/g/${token}/image/${readyId}?size=preview`);
      expect(thumb.status()).toBe(200); expect(preview.status()).toBe(200);
      const sharedLogo = await request.get("/g/" + token + "/brand-logo");
      expect(sharedLogo.status()).toBe(200);
      expect(sharedLogo.headers()["content-type"]).toContain("image/webp");
      expect(sharedLogo.headers()["cache-control"]).toContain("no-store");
      expect(thumb.headers()["content-type"]).toContain("image/webp");
      expect(preview.headers()["cache-control"]).toContain("no-store");
      expect((await request.get(`/g/${token}/image/${otherPhotoId}?size=preview`)).status()).toBe(404);
      expect((await request.get(`/g/${token}/image/${pendingId}?size=thumb`)).status()).toBe(404);
      expect((await request.get(`/g/${"0".repeat(64)}/image/${readyId}?size=thumb`)).status()).toBe(404);
      const originalPath = `${tenantId}/${galleryId}/${readyId}.png`;
      expect((await request.get(`${local.API_URL}/storage/v1/object/public/gallery-originals/${originalPath}`)).ok()).toBeFalsy();

      const anonymous = createClient(local.API_URL, local.PUBLISHABLE_KEY, { auth: { persistSession: false } });
      expect((await anonymous.rpc("set_gallery_selection", { p_token: token, p_photo_id: otherPhotoId, p_selected: true })).error?.code).toBe("42501");
      expect((await anonymous.rpc("set_gallery_selection", { p_token: token, p_photo_id: pendingId, p_selected: true })).error?.code).toBe("42501");
      await expect(visitor.getByText("1 foto escolhida", { exact: true })).toBeVisible();
      await expect(visitor.getByRole("button", { name: "Selecionar segunda.png" })).toBeDisabled();
      expect((await anonymous.rpc("set_gallery_selection", { p_token: token, p_photo_id: secondId, p_selected: true })).error?.message).toContain("SELECTION_LIMIT");
      await expect(visitor.getByText("1 foto escolhida", { exact: true })).toBeVisible();
      await visitor.reload();
      await expect(visitor.getByRole("button", { name: "Remover seleção pronta.png" })).toBeVisible();
      await expect(visitor.getByText("1 foto escolhida", { exact: true })).toBeVisible();
      await visitor.getByLabel("Seu nome").fill("Cliente do ensaio");
      visitor.once("dialog", dialog => dialog.accept());
      await visitor.getByRole("button", { name: "Revisar e enviar seleção" }).click();
      await expect(visitor.getByRole("status").filter({ hasText: "Seleção enviada" })).toBeVisible();
      await visitor.reload();
      await expect(visitor.getByText("Sua seleção foi enviada e está fechada para alterações.")).toBeVisible();
      await expect(visitor.getByRole("button", { name: "Selecionar segunda.png" })).toHaveCount(0);
      expect((await anonymous.rpc("set_gallery_selection", { p_token: token, p_photo_id: secondId, p_selected: true })).error?.message).toContain("SELECTION_SUBMITTED");
      expect((await anonymous.rpc("set_gallery_selection_photo_note", { p_token: token, p_photo_id: readyId, p_note: "alteração após envio" })).error?.message).toContain("SELECTION_SUBMITTED");
      expect((await anonymous.rpc("submit_gallery_selection", { p_token: token, p_client_name: "Cliente do ensaio" })).data).toBe(true);
      await page.reload();
      await expect(page.getByText("Seleção enviada por Cliente do ensaio", { exact: false })).toBeVisible();
      await expect(page.getByText(/^Aviso ao fotógrafo:/)).toBeVisible();
      await expect(page.getByText("pronta.png", { exact: true })).toHaveCount(1);
      await expect(page.getByText("Observação do cliente: Remover a placa refletida no vidro.", { exact: true })).toBeVisible();
      await expect(page.getByText("Downloads dos originais desativados", { exact: true })).toBeVisible();
      await page.goto(`/painel/${tenantId}`);
      await expect(page.getByRole("heading", { name: /Seleções recebidas/ })).toBeVisible();
      await expect(page.getByText("Cliente do ensaio", { exact: false })).toBeVisible();
      await expect(page.locator(".gallery-dashboard-card").filter({ has: page.getByRole("heading", { name: "Ensaio para cliente" }) }).getByText("Seleção aguardando conferência", { exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Conferir seleção" }).click();
      await expect(page).toHaveURL(new RegExp(`/painel/${tenantId}/galerias/${galleryId}$`));
      await expect(page.getByText("Seleção enviada por Cliente do ensaio", { exact: false })).toBeVisible();
      const [selectionCsv] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: "Baixar lista CSV" }).click(),
      ]);
      expect(selectionCsv.suggestedFilename()).toBe("selecao-ensaio-para-cliente.csv");
      const selectionCsvPath = await selectionCsv.path();
      expect(selectionCsvPath).toBeTruthy();
      const selectionCsvText = await readFile(selectionCsvPath!, "utf8");
      expect(selectionCsvText).toContain('"Arquivo original"');
      expect(selectionCsvText).toContain('"Observação do cliente"');
      expect(selectionCsvText).toContain('"Remover a placa refletida no vidro."');
      expect(selectionCsvText).toContain('"pronta.png"');
      await page.getByRole("button", { name: "Marcar como conferida" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Seleção marcada como conferida." })).toBeVisible();
      await page.goto(`/painel/${tenantId}`);
      await expect(page.getByRole("heading", { name: /Seleções recebidas/ })).toHaveCount(0);
      await page.goto(`/painel/${tenantId}/galerias/${galleryId}`);
      expect((await request.get(`/g/${token}/download/${readyId}`, { maxRedirects: 0 })).status()).toBe(404);
      const permissionResponse = page.waitForResponse(response => response.url().includes("set_gallery_share_downloads"));
      page.once("dialog", dialog => dialog.accept());
      await page.getByRole("button", { name: "Liberar download dos originais" }).click();
      const permissionResult = await permissionResponse;
      if (!permissionResult.ok()) throw new Error(`Configuração de download recusada (${permissionResult.status()}): ${await permissionResult.text()}`);
      await expect(page.getByRole("status").filter({ hasText: "Download dos originais liberado" })).toBeVisible();
      await visitor.reload();
      await expect(visitor.getByRole("link", { name: "Baixar original" })).toBeVisible();
      const firstGrant = await request.get(`/g/${token}/download/${readyId}`, { maxRedirects: 0 });
      expect(firstGrant.status()).toBe(302);
      expect(firstGrant.headers()["cache-control"]).toContain("no-store");
      const signedDownload = await request.get(firstGrant.headers().location);
      expect(signedDownload.status()).toBe(200);
      expect(signedDownload.headers()["content-disposition"]).toContain("attachment");
      expect((await request.get(`/g/${token}/download/${readyId}`, { maxRedirects: 0 })).status()).toBe(302);
      expect((await request.get(`/g/${token}/download/${readyId}`, { maxRedirects: 0 })).status()).toBe(302);
      expect((await request.get(`/g/${token}/download/${readyId}`, { maxRedirects: 0 })).status()).toBe(429);
      await page.reload();
      await expect(page.getByText(/pronta\.png: 3 emissões de download/)).toBeVisible();

      await page.getByLabel("Orientação para ajustes (visível ao cliente)").fill("Revise a escolha e selecione também a imagem da recepção.");
      page.once("dialog", dialog => {
        expect(dialog.message()).toContain(customerEmail);
        return dialog.accept();
      });
      await page.getByRole("button", { name: "Solicitar ajustes na seleção" }).click();
      await expect(page.getByRole("status").filter({ hasText: `O aviso será enviado para ${customerEmail}` })).toBeVisible();
      const revisionMessage = new URL((await page.getByRole("link", { name: "Avisar cliente pelo WhatsApp" }).getAttribute("href"))!).searchParams.get("text")!;
      const revisionWhatsAppUrl = new URL((await page.getByRole("link", { name: "Avisar cliente pelo WhatsApp" }).getAttribute("href"))!);
      expect(revisionWhatsAppUrl.pathname).toBe("/5511998765432");
      expect(revisionMessage).not.toContain(customerWhatsAppPhone);
      expect(revisionMessage).toContain("Revise a escolha e selecione também a imagem da recepção.");
      expect(revisionMessage).toContain("Abra novamente o mesmo link");
      await page.reload();
      await expect(page.getByRole("link", { name: "Avisar cliente pelo WhatsApp" })).toBeVisible();
      await expect(page.getByText(/^Aviso ao cliente:/)).toBeVisible();
      await visitor.reload();
      await expect(visitor.getByText("O fotógrafo pediu ajustes na sua seleção")).toBeVisible();
      await expect(visitor.getByText("Revise a escolha e selecione também a imagem da recepção.")).toBeVisible();
      await expect(visitor.getByRole("link", { name: "Baixar original" })).toHaveCount(0);
      await visitor.getByRole("button", { name: "Remover seleção pronta.png" }).click();
      await visitor.getByRole("button", { name: "Selecionar segunda.png" }).click();
      await visitor.getByLabel("Seu nome").fill("Cliente do ensaio — revisão");
      visitor.once("dialog", dialog => dialog.accept());
      await visitor.getByRole("button", { name: "Revisar e enviar seleção" }).click();
      await expect(visitor.getByRole("status").filter({ hasText: "Seleção enviada" })).toBeVisible();
      await page.reload();
      await page.goto(`/painel/${tenantId}`);
      await expect(page.getByRole("heading", { name: /Seleções recebidas/ })).toBeVisible();
      await expect(page.getByText("Cliente do ensaio — revisão", { exact: false })).toBeVisible();
      await page.getByRole("link", { name: "Conferir seleção" }).click();
      await expect(page).toHaveURL(new RegExp(`/painel/${tenantId}/galerias/${galleryId}$`));
      await page.getByText("Histórico de revisões (1)").click();
      await expect(page.getByText(/Versão 1 · enviada por Cliente do ensaio/)).toBeVisible();
      await expect(page.getByText("Orientação enviada: Revise a escolha e selecione também a imagem da recepção.", { exact: true })).toBeVisible();

      await expect(page.getByRole("button", { name: "Revogar link" })).toBeEnabled();
      await expect(page.getByText("Observação do cliente: Remover a placa refletida no vidro.", { exact: true })).toBeVisible();
      page.once("dialog", dialog => dialog.accept());
      await page.getByRole("button", { name: "Revogar link" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Link revogado." })).toBeVisible();
      expect((await request.get(`/g/${token}/image/${readyId}?size=thumb`)).status()).toBe(404);
      expect((await request.get(`/g/${token}/download/${readyId}`, { maxRedirects: 0 })).status()).toBe(404);
      expect((await visitor.goto(url))?.status()).toBe(404);
      expect((await request.get("/g/" + token + "/brand-logo")).status()).toBe(404);

      const extraPhotos = Array.from({ length: 65 }, (_, index) => {
        const id = crypto.randomUUID();
        return {
          id,
          tenant_id: tenantId,
          gallery_id: galleryId,
          object_path: `${tenantId}/${galleryId}/${id}.png`,
          original_filename: `lote-${String(index + 1).padStart(2, "0")}.png`,
          content_type: "image/png",
          byte_size: 8,
          created_by: userId,
          processing_status: "ready",
          processed_at: new Date().toISOString(),
          sort_order: 100 + index,
        };
      });
      const insertedExtraPhotos = await admin.from("photos").insert(extraPhotos).select("id");
      expect(insertedExtraPhotos.error).toBeNull();

      await page.getByLabel("Modo do link").selectOption("delivery");
      page.once("dialog", dialog => dialog.accept());
      await page.getByRole("button", { name: "Criar link" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Link criado" })).toBeVisible();
      const deliveryUrl = await page.locator('input[readonly]').inputValue();
      const deliveryToken = new URL(deliveryUrl).pathname.split("/").at(-1)!;
      const deliveryShare = await admin.from("gallery_shares").select("id, share_mode, downloads_enabled").eq("gallery_id", galleryId).eq("share_mode", "delivery").single();
      expect(deliveryShare.error).toBeNull();
      expect(deliveryShare.data).toMatchObject({ share_mode: "delivery", downloads_enabled: true });
      const deliveryPage = await visitor.goto(deliveryUrl);
      expect(deliveryPage?.status()).toBe(200);
      await expect(visitor.getByRole("heading", { name: "Entrega completa" })).toBeVisible();
      await expect(visitor.getByLabel("Seu nome", { exact: true })).toHaveCount(0);
      const deliveryGallery = await anonymous.rpc("get_shared_gallery", { p_token: deliveryToken });
      expect(deliveryGallery.error).toBeNull();
      expect(deliveryGallery.data.photo_count).toBe(extraPhotos.length + 2);
      await expect(visitor.locator(".gallery-photo-card")).toHaveCount(60);
      const deliveryViewer = visitor.getByRole("dialog", { name: "Visualizador de fotos" });
      await visitor.getByRole("button", { name: "Ampliar lote-58.png" }).click();
      await expect(deliveryViewer.getByRole("heading", { name: "lote-58.png" })).toBeVisible();
      await visitor.keyboard.press("ArrowRight");
      await expect(deliveryViewer.getByRole("heading", { name: "lote-59.png" })).toBeVisible();
      await expect(deliveryViewer.locator(".photo-lightbox-count")).toHaveText("61 / 67");
      const touchSession = await visitor.context().newCDPSession(visitor);
      try {
        const stageBox = await deliveryViewer.locator(".photo-lightbox-stage").boundingBox();
        expect(stageBox).not.toBeNull();
        const point = { x: stageBox!.x + stageBox!.width * 0.72, y: stageBox!.y + stageBox!.height * 0.5 };
        await touchSession.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
        await touchSession.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, x: point.x - 150 }] });
        await touchSession.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect(deliveryViewer.getByRole("heading", { name: "lote-60.png" })).toBeVisible();
        await touchSession.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, x: point.x - 150 }] });
        await touchSession.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point] });
        await touchSession.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect(deliveryViewer.getByRole("heading", { name: "lote-59.png" })).toBeVisible();
      } finally {
        await touchSession.detach();
      }
      await visitor.keyboard.press("Escape");
      await visitor.getByLabel("Buscar pelo nome do arquivo").fill("lote-65.png");
      await expect(visitor.getByRole("img", { name: "lote-65.png" })).toBeVisible();
      await expect(visitor.locator(".gallery-photo-card")).toHaveCount(1);
      await visitor.getByLabel("Buscar pelo nome do arquivo").fill("");
      await expect(visitor.locator(".gallery-photo-card")).toHaveCount(60);
      await visitor.getByRole("button", { name: "Carregar mais fotos" }).click();
      await expect(visitor.locator(".gallery-photo-card")).toHaveCount(extraPhotos.length + 2);
      const unavailableExtraPhotos = await admin.from("photos").update({ processing_status: "failed", processed_at: null })
        .in("id", insertedExtraPhotos.data!.map(photo => photo.id));
      expect(unavailableExtraPhotos.error).toBeNull();
      await visitor.reload();
      const readyDeliveryGallery = await anonymous.rpc("get_shared_gallery", { p_token: deliveryToken });
      expect(readyDeliveryGallery.error).toBeNull();
      await expect(visitor.getByRole("link", { name: "Baixar original" })).toHaveCount(readyDeliveryGallery.data.photo_count);
      const deliveryViewerAfterReload = visitor.getByRole("dialog", { name: "Visualizador de fotos" });
      await visitor.getByRole("button", { name: "Ampliar pronta.png" }).click();
      await expect(deliveryViewerAfterReload.getByRole("link", { name: "Baixar original" })).toBeVisible();
      await expect(deliveryViewerAfterReload.getByRole("button", { name: /Selecionar|Remover seleção/ })).toHaveCount(0);
      await visitor.keyboard.press("Escape");
      await expect(deliveryViewerAfterReload).toBeHidden();
      await expect(visitor.getByRole("button", { name: /Selecionar/ })).toHaveCount(0);
      await expect(visitor.getByRole("button", { name: /Revisar e enviar/ })).toHaveCount(0);
      expect((await anonymous.rpc("set_gallery_selection", { p_token: deliveryToken, p_photo_id: secondId, p_selected: true })).error?.message).toContain("SELECTION_MODE_DISABLED");
      expect((await anonymous.rpc("submit_gallery_selection", { p_token: deliveryToken, p_client_name: "Cliente do ensaio" })).error?.message).toContain("SELECTION_MODE_DISABLED");
      const deliveryGrant = await request.get(`/g/${deliveryToken}/download/${secondId}`, { maxRedirects: 0 });
      expect(deliveryGrant.status()).toBe(302);
      expect((await request.get(deliveryGrant.headers().location)).status()).toBe(200);
      const bundle = await request.get(`/g/${deliveryToken}/download/zip`);
      expect(bundle.status()).toBe(200);
      expect(bundle.headers()["content-type"]).toContain("application/zip");
      expect(bundle.headers()["content-disposition"]).toContain("attachment");
      const zip = await bundle.body();
      expect(zip.subarray(0, 4).toString("hex")).toBe("504b0304");
      expect(zip.includes(Buffer.from("pronta.png"))).toBe(true);
      expect(zip.includes(Buffer.from("segunda.png"))).toBe(true);
      await expect(page.getByRole("button", { name: "Desativar download dos originais" })).toBeVisible();
      page.once("dialog", dialog => dialog.accept());
      await page.getByRole("button", { name: "Desativar download dos originais" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Download dos originais desativado" })).toBeVisible();
      await visitor.reload();
      await expect(visitor.getByRole("link", { name: "Baixar original" })).toHaveCount(0);
      expect((await request.get(`/g/${deliveryToken}/download/${readyId}`, { maxRedirects: 0 })).status()).toBe(404);
      const unavailablePhotos = await admin.from("photos").update({ processing_status: "failed" }).in("id", [readyId, secondId]);
      expect(unavailablePhotos.error).toBeNull();
      await page.reload();
      await expect(page.getByRole("button", { name: "Gerar novo link" })).toBeDisabled();
      const deniedRotation = await member.rpc("rotate_gallery_share", {
        p_tenant_id: tenantId,
        p_gallery_id: galleryId,
        p_share_id: deliveryShare.data!.id,
        p_expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      });
      expect(deniedRotation.error?.message).toContain("SHARE_NO_READY_PHOTOS");
      const restoredPhotos = await admin.from("photos").update({ processing_status: "ready" }).in("id", [readyId, secondId]);
      expect(restoredPhotos.error).toBeNull();
      await page.reload();
      await page.evaluate(() => {
        window.confirm = message => {
          window.sessionStorage.setItem("share-rotation-confirm", message ?? "");
          return true;
        };
      });
      await page.getByRole("button", { name: "Gerar novo link" }).click();
      expect(await page.evaluate(() => window.sessionStorage.getItem("share-rotation-confirm")))
        .toContain("O endereço atual será invalidado imediatamente");
      await expect(page.getByRole("status").filter({ hasText: "Novo link gerado. O endereço anterior foi invalidado." })).toBeVisible();
      const rotatedDeliveryUrl = await page.getByLabel("Novo link").inputValue();
      const rotatedDeliveryToken = new URL(rotatedDeliveryUrl).pathname.split("/").at(-1)!;
      expect(rotatedDeliveryToken).not.toBe(deliveryToken);
      expect((await request.get(`/g/${deliveryToken}/image/${readyId}?size=preview`)).status()).toBe(404);
      expect((await visitor.goto(deliveryUrl))?.status()).toBe(404);
      await expect(visitor.getByRole("heading", { name: "Este link não está disponível" })).toBeVisible();
      const rotatedShare = await admin.from("gallery_shares")
        .select("id, last_rotated_at, expires_at, share_mode, downloads_enabled")
        .eq("id", deliveryShare.data!.id).single();
      expect(rotatedShare.error).toBeNull();
      expect(rotatedShare.data).toMatchObject({
        id: deliveryShare.data!.id, share_mode: "delivery", downloads_enabled: false,
      });
      expect(rotatedShare.data?.last_rotated_at).not.toBeNull();
      expect(new Date(rotatedShare.data!.expires_at).getTime()).toBeGreaterThan(Date.now());
      expect((await visitor.goto(rotatedDeliveryUrl))?.status()).toBe(200);
      await expect(visitor.getByRole("heading", { name: "Entrega completa" })).toBeVisible();
      await expect(visitor.getByRole("link", { name: "Baixar original" })).toHaveCount(0);
      await page.getByLabel("Modo do link").selectOption("selection");
      await page.getByRole("button", { name: "Criar link" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Link criado" })).toBeVisible();
      const expiring = new URL(await page.locator('input[readonly]').inputValue()).pathname.split("/").at(-1)!;
      const shares = await admin.from("gallery_shares").select("id").eq("gallery_id", galleryId).eq("share_mode", "selection").is("revoked_at", null).single();
      expect(shares.error).toBeNull();
      expect((await admin.from("gallery_shares").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", shares.data!.id)).error).toBeNull();
      expect((await request.get(`/g/${expiring}/image/${readyId}?size=preview`)).status()).toBe(404);
      expect((await visitor.goto(`${new URL(url).origin}/g/${expiring}`))?.status()).toBe(404);
      await expect(visitor.getByRole("heading", { name: "Este link não está disponível" })).toBeVisible();
      expect((await visitor.goto(`${new URL(url).origin}/g/${"0".repeat(64)}`))?.status()).toBe(404);
      await expect(visitor.getByRole("heading", { name: "Este link não está disponível" })).toBeVisible();

      await page.getByLabel("PIN opcional").fill("12345678");
      await page.getByRole("button", { name: "Criar link" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Envie o PIN ao cliente" })).toBeVisible();
      const protectedUrl = await page.locator('input[readonly]').inputValue();
      const protectedToken = new URL(protectedUrl).pathname.split("/").at(-1)!;
      expect((await request.get("/g/" + protectedToken + "/brand-logo")).status()).toBe(404);
      const protectedPreview = await request.get(protectedUrl);
      const protectedHtml = await protectedPreview.text();
      expect(protectedPreview.status()).toBe(200);
      expect(protectedHtml).toContain('property="og:title" content="Galeria protegida | Quadrics"');
      expect(protectedHtml).not.toContain("Ensaio para cliente");
      expect(protectedHtml).not.toContain('property="og:image"');
      expect((await request.get(`/g/${protectedToken}/share-card`)).status()).toBe(404);
      const protectedMessage = new URL((await page.getByRole("link", { name: "Compartilhar pelo WhatsApp" }).getAttribute("href"))!).searchParams.get("text")!;
      const protectedWhatsAppUrl = new URL((await page.getByRole("link", { name: "Compartilhar pelo WhatsApp" }).getAttribute("href"))!);
      expect(protectedWhatsAppUrl.pathname).toBe("/5511998765432");
      expect(protectedMessage).toContain(protectedUrl);
      expect(protectedMessage).toContain("O PIN de acesso deve ser enviado por uma mensagem separada.");
      expect(protectedMessage).not.toContain("12345678");
      const protectedShare = await admin.from("gallery_shares").select("pin_enabled").eq("gallery_id", galleryId).eq("pin_enabled", true).single();
      expect(protectedShare.error).toBeNull();
      expect(protectedShare.data?.pin_enabled).toBe(true);
      await visitor.goto(protectedUrl);
      await expect(visitor.getByRole("heading", { name: "Digite o PIN da galeria" })).toBeVisible();
      await expect(visitor.getByRole("img", { name: "pronta.png" })).toHaveCount(0);
      expect((await request.get(`/g/${protectedToken}/image/${readyId}?size=preview`)).status()).toBe(404);
      await visitor.getByRole("textbox", { name: "PIN" }).fill("00000000");
      await visitor.getByRole("button", { name: "Abrir galeria" }).click();
      await expect(visitor.getByRole("alert").filter({ hasText: "PIN incorreto" })).toBeVisible();
      await visitor.getByRole("textbox", { name: "PIN" }).fill("12345678");
      await visitor.getByRole("button", { name: "Abrir galeria" }).click();
      await expect(visitor.getByRole("heading", { name: "Ensaio para cliente" })).toBeVisible();
      await expect(visitor.getByRole("img", { name: "pronta.png" })).toBeVisible();
      await visitor.getByRole("button", { name: "Selecionar pronta.png" }).click();
      await expect(visitor.getByRole("status").filter({ hasText: "Escolha salva." })).toBeVisible();

      await page.getByLabel("PIN opcional").fill("87654321");
      await page.getByRole("button", { name: "Criar link" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Envie o PIN ao cliente" })).toBeVisible();
      const limitedUrl = await page.locator('input[readonly]').inputValue();
      const limitedToken = new URL(limitedUrl).pathname.split("/").at(-1)!;
      await visitor.goto(limitedUrl);
      for (let attempt = 0; attempt < 5; attempt++) {
        await visitor.getByRole("textbox", { name: "PIN" }).fill("00000000");
        await visitor.getByRole("button", { name: "Abrir galeria" }).click();
        await expect(visitor.getByRole("alert").filter({ hasText: "PIN incorreto." })).toHaveText("PIN incorreto.");
      }
      await visitor.getByRole("textbox", { name: "PIN" }).fill("87654321");
      const blockedResponsePromise = visitor.waitForResponse(response =>
        response.url().endsWith(`/g/${limitedToken}/unlock`),
      );
      await visitor.getByRole("button", { name: "Abrir galeria" }).click();
      const blockedResponse = await blockedResponsePromise;
      expect(blockedResponse.status()).toBe(429);
      expect(blockedResponse.headers()["retry-after"]).toBe("3600");
      await expect(visitor.getByRole("alert").filter({ hasText: "Muitas tentativas incorretas" }))
        .toContainText("Muitas tentativas incorretas deste endereço de acesso");

      await page.getByRole("button", { name: "Criar link" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Link criado" })).toBeVisible();
      const archivedToken = new URL(await page.locator('input[readonly]').inputValue()).pathname.split("/").at(-1)!;
      expect((await member.from("galleries").update({ status: "archived" }).eq("id", galleryId)).error).toBeNull();
      expect((await request.get(`/g/${archivedToken}/image/${readyId}?size=preview`)).status()).toBe(404);
      expect((await member.from("galleries").update({ status: "published" }).eq("id", galleryId)).error).toBeNull();
      expect((await request.get(`/g/${archivedToken}/image/${readyId}?size=preview`)).status()).toBe(404);
      const queuedNotifications = await admin.from("gallery_notification_outbox")
        .select("share_id, attempts, sent_at, failed_at")
        .eq("tenant_id", tenantId).eq("gallery_id", galleryId).order("created_at");
      expect(queuedNotifications.error).toBeNull();
      expect(queuedNotifications.data).toHaveLength(3);
      expect(new Set(queuedNotifications.data!.map(notification => notification.share_id)).size).toBe(1);
      const notificationShareId = queuedNotifications.data![0].share_id;

      const failedDelivery = runNotificationWorker(notificationShareId, 1);
      expect(failedDelivery.status, `${failedDelivery.stderr}\n${failedDelivery.stdout}`).toBe(1);
      expect(JSON.parse(failedDelivery.stdout)).toMatchObject({ examined: 3, sent: 0, retry: 3, failed: 0 });
      const deferredNotifications = await admin.from("gallery_notification_outbox")
        .select("attempts, available_at, sent_at, failed_at, last_error_code")
        .eq("share_id", notificationShareId).order("created_at");
      expect(deferredNotifications.error).toBeNull();
      expect(deferredNotifications.data).toHaveLength(3);
      for (const notification of deferredNotifications.data!) {
        expect(notification).toMatchObject({ attempts: 1, sent_at: null, failed_at: null, last_error_code: "smtp_send_failed" });
        expect(Date.parse(notification.available_at)).toBeGreaterThan(Date.now() + 45_000);
      }

      const releaseRetry = await admin.from("gallery_notification_outbox")
        .update({ available_at: new Date(0).toISOString() })
        .eq("share_id", notificationShareId).is("sent_at", null).is("failed_at", null);
      expect(releaseRetry.error).toBeNull();
      const recoveredDelivery = runNotificationWorker(notificationShareId, 54325);
      expect(recoveredDelivery.status, recoveredDelivery.stderr).toBe(0);
      expect(JSON.parse(recoveredDelivery.stdout)).toMatchObject({ examined: 3, sent: 3, retry: 0, failed: 0 });
      const duplicateDelivery = runNotificationWorker(notificationShareId, 54325);
      expect(duplicateDelivery.status, duplicateDelivery.stderr).toBe(0);
      expect(JSON.parse(duplicateDelivery.stdout)).toMatchObject({ examined: 0, sent: 0, retry: 0, failed: 0 });
      const deliveredNotifications = await admin.from("gallery_notification_outbox")
        .select("attempts, sent_at, failed_at, last_error_code")
        .eq("share_id", notificationShareId).order("created_at");
      expect(deliveredNotifications.error).toBeNull();
      expect(deliveredNotifications.data).toHaveLength(3);
      for (const notification of deliveredNotifications.data!) {
        expect(notification).toMatchObject({ attempts: 2, failed_at: null, last_error_code: null });
        expect(notification.sent_at).toBeTruthy();
      }

      const latestSelectionNotice = await admin.from("gallery_notification_outbox")
        .select("id")
        .eq("share_id", notificationShareId)
        .eq("notification_type", "selection_submitted")
        .order("event_version", { ascending: false })
        .limit(1)
        .single();
      expect(latestSelectionNotice.error).toBeNull();
      const markAsPermanentlyFailed = await admin.from("gallery_notification_outbox")
        .update({ attempts: 5, claimed_at: null, sent_at: null, failed_at: new Date().toISOString(), last_error_code: "max_attempts" })
        .eq("id", latestSelectionNotice.data!.id);
      expect(markAsPermanentlyFailed.error).toBeNull();
      await page.goto(`/painel/${tenantId}/galerias/${galleryId}`);
      await expect(page.getByText(/Aviso ao fotógrafo: O envio automático falhou após 5 tentativas/)).toBeVisible();
      await page.getByRole("button", { name: "Tentar novamente por e-mail" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Novo envio de e-mail colocado na fila." })).toBeVisible();
      await expect(page.getByText(/Aviso ao fotógrafo: Aviso aguardando envio por e-mail\./)).toBeVisible();
      const manualRetryDelivery = runNotificationWorker(notificationShareId, 54325);
      expect(manualRetryDelivery.status, manualRetryDelivery.stderr).toBe(0);
      expect(JSON.parse(manualRetryDelivery.stdout)).toMatchObject({ examined: 1, sent: 1, retry: 0, failed: 0 });
      const manuallyRetried = await admin.from("gallery_notification_outbox")
        .select("attempts, manual_retry_count, sent_at, failed_at, last_error_code")
        .eq("id", latestSelectionNotice.data!.id)
        .single();
      expect(manuallyRetried.error).toBeNull();
      expect(manuallyRetried.data).toMatchObject({ attempts: 1, manual_retry_count: 1, failed_at: null, last_error_code: null });
      expect(manuallyRetried.data?.sent_at).toBeTruthy();
    } finally { await shared.close(); }
  } finally {
    if (tenantId) {
      await cleanupTenantStorage(admin, tenantId);
      expect((await admin.from("galleries").delete().eq("tenant_id", tenantId)).error).toBeNull();
      expect((await admin.from("customers").delete().eq("tenant_id", tenantId)).error).toBeNull();
      expect((await admin.from("tenants").delete().eq("id", tenantId)).error).toBeNull();
    }
    if (userId) expect((await admin.auth.admin.deleteUser(userId)).error).toBeNull();
  }
});
