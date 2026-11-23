import { quadricsEnv } from "../../scripts/lib/quadrics-env.mjs";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { cleanupTenantStorage } from "./support/storage-cleanup.mjs";

const apiUrl = quadricsEnv("TEST_SUPABASE_URL");
const publishableKey = quadricsEnv("TEST_SUPABASE_PUBLISHABLE_KEY");
const secretKey = quadricsEnv("TEST_SUPABASE_SECRET_KEY");
const restoreProjectId = quadricsEnv("TEST_RESTORE_PROJECT_ID");

if (!apiUrl || !publishableKey || !secretKey || !/^cartlio-restore-[a-f0-9]{8}$/.test(restoreProjectId ?? "")) {
  throw new Error("The restored-instance E2E test requires the isolated Supabase credentials.");
}
const supabaseHost = new URL(apiUrl);
if (supabaseHost.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(supabaseHost.hostname)) {
  throw new Error("The restored-instance E2E test only accepts a local disposable Supabase endpoint.");
}

const admin = createClient(apiUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });

test("a restored instance preserves member access and accepts new users, uploads, and client selections", async ({ page, browser, request }) => {
  test.setTimeout(180_000);
  const suffix = crypto.randomUUID();
  const email = `restore-${suffix}@cartlio.test`;
  const password = `Restore-${suffix}-Pass!`;
  const workspaceName = `Restore smoke ${suffix.slice(0, 8)}`;
  const galleryTitle = `Galeria de restauração ${suffix.slice(0, 8)}`;
  let userId: string | undefined;
  let tenantId: string | undefined;
  let galleryId: string | undefined;

  try {
    const restoredMemberships = await admin.from("tenant_members").select("tenant_id, user_id").limit(1000);
    expect(restoredMemberships.error).toBeNull();
    const fixtureEmail = quadricsEnv("RESTORE_FIXTURE_EMAIL");
    const fixturePassword = quadricsEnv("RESTORE_FIXTURE_PASSWORD");
    expect(Boolean(fixtureEmail)).toBe(Boolean(fixturePassword));
    let restoredLogin: { email: string; password: string; tenantId: string } | null = null;

    if (fixtureEmail && fixturePassword) {
      const users = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      expect(users.error).toBeNull();
      const fixtureUser = users.data.users.find(user => user.email === fixtureEmail);
      expect(fixtureUser?.email_confirmed_at).toBeTruthy();
      const membership = restoredMemberships.data?.find(item => item.user_id === fixtureUser?.id);
      expect(membership).toBeDefined();
      restoredLogin = { email: fixtureEmail, password: fixturePassword, tenantId: membership!.tenant_id };
    } else if (restoredMemberships.data?.[0]) {
      const membership = restoredMemberships.data[0];
      const restoredUser = await admin.auth.admin.getUserById(membership.user_id);
      expect(restoredUser.error).toBeNull();
      const user = restoredUser.data.user;
      if (!user) throw new Error("A restored member account is missing.");
      if (user.email) {
        // Passwords are changed only in this disposable project; backup data and source accounts remain untouched.
        const temporaryPassword = `Restored-${suffix}-Pass!`;
        const passwordReset = await admin.auth.admin.updateUserById(user.id, {
          password: temporaryPassword,
          email_confirm: true,
        });
        expect(passwordReset.error).toBeNull();
        restoredLogin = { email: user.email, password: temporaryPassword, tenantId: membership.tenant_id };
      }
    }

    if (restoredLogin) {
      const restoredWorkspace = await admin.from("tenants").select("name").eq("id", restoredLogin.tenantId).single();
      expect(restoredWorkspace.error).toBeNull();
      if (!restoredWorkspace.data) throw new Error("The restored workspace is missing.");
      const restoredLoginPage = await browser.newPage();
      try {
        await restoredLoginPage.goto("/login");
        await restoredLoginPage.getByLabel("E-mail", { exact: true }).fill(restoredLogin.email);
        await restoredLoginPage.getByLabel("Senha", { exact: true }).fill(restoredLogin.password);
        await restoredLoginPage.getByRole("button", { name: "Entrar", exact: true }).click();
        await restoredLoginPage.waitForURL("**/painel");
        await expect(restoredLoginPage.getByText(restoredWorkspace.data.name, { exact: true })).toBeVisible();
        await restoredLoginPage.goto(`/painel/${restoredLogin.tenantId}`);
        await expect(restoredLoginPage.getByRole("heading", { name: "Galerias", exact: true })).toBeVisible();
      } finally {
        await restoredLoginPage.close();
      }
    }

    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    userId = created.data.user!.id;

    const member = createClient(apiUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await member.auth.signInWithPassword({ email, password })).error).toBeNull();
    const workspace = await member.rpc("create_workspace", {
      p_name: workspaceName,
      p_slug: `restore-${suffix}`,
    });
    expect(workspace.error).toBeNull();
    tenantId = workspace.data as string;

    const gallery = await member.from("galleries").insert({
      tenant_id: tenantId,
      title: galleryTitle,
      slug: `gallery-${suffix}`,
      status: "draft",
    }).select("id").single();
    expect(gallery.error).toBeNull();
    galleryId = gallery.data!.id;

    await page.goto("/login");
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL("**/painel");
    await expect(page.getByRole("link", { name: new RegExp(workspaceName) })).toBeVisible();

    await page.goto(`/painel/${tenantId}`);
    await expect(page.getByRole("heading", { name: "Galerias", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: galleryTitle, exact: true })).toBeVisible();
    await page.getByRole("link", { name: new RegExp(galleryTitle) }).click();

    const imageBytes = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 8;
      canvas.height = 8;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is unavailable.");
      context.fillStyle = "#b87532";
      context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png").split(",")[1];
    }), "base64");
    await page.locator('input[type="file"]').setInputFiles({
      name: "restore-e2e.png",
      mimeType: "image/png",
      buffer: imageBytes,
    });
    await page.getByRole("button", { name: "Enviar imagens", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "1 imagem enviada." })).toBeVisible();

    const processed = JSON.parse(execFileSync(process.execPath, [
      "scripts/process-images.mjs", "--remote", "--tenant", tenantId,
    ], {
      encoding: "utf8",
      env: { ...process.env, SUPABASE_URL: apiUrl, SUPABASE_SERVER_SECRET_KEY: secretKey },
    })) as { examined: number; ready: number; invalid: number; retry: number; failed: number };
    expect(processed).toMatchObject({ examined: 1, ready: 1, invalid: 0, retry: 0, failed: 0 });
    await page.reload();
    await expect(page.getByRole("img", { name: "restore-e2e.png", exact: true })).toBeVisible();

    const photo = await admin.from("photos").select("id, object_path")
      .eq("tenant_id", tenantId).eq("gallery_id", galleryId).single();
    expect(photo.error).toBeNull();
    await page.locator('select[name="status"]').selectOption("published");
    await page.getByRole("button", { name: "Salvar alterações", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Galeria atualizada." })).toBeVisible();
    await page.getByLabel("Limite de escolhas").selectOption("1");
    await page.getByRole("button", { name: "Criar link", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Link criado" })).toBeVisible();
    const shareUrl = await page.getByLabel("Novo link", { exact: true }).inputValue();
    const token = new URL(shareUrl).pathname.split("/").at(-1)!;
    const preview = await request.get(`/g/${token}/image/${photo.data!.id}?size=preview`);
    expect(preview.status()).toBe(200);
    expect(preview.headers()["content-type"]).toContain("image/webp");
    expect(preview.headers()["cache-control"]).toContain("no-store");
    const publicOriginal = await request.get(`${apiUrl}/storage/v1/object/public/gallery-originals/${photo.data!.object_path}`);
    expect(publicOriginal.ok()).toBeFalsy();

    const visitor = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      expect((await visitor.goto(shareUrl))?.status()).toBe(200);
      await expect(visitor.getByRole("heading", { name: galleryTitle, exact: true })).toBeVisible();
      await expect(visitor.getByRole("img", { name: "restore-e2e.png", exact: true })).toBeVisible();
      await visitor.getByRole("button", { name: "Selecionar restore-e2e.png" }).click();
      await expect(visitor.getByText("1 foto escolhida", { exact: true })).toBeVisible();
      await visitor.getByLabel("Seu nome").fill("Cliente E2E");
      visitor.once("dialog", dialog => dialog.accept());
      await visitor.getByRole("button", { name: /Revisar e enviar sele/ }).click();
      await expect(visitor.getByRole("status").filter({ hasText: "Seleção enviada" })).toBeVisible();
      await visitor.reload();
      await expect(visitor.getByText(/seleção foi enviada/i)).toBeVisible();
    } finally {
      await visitor.close();
    }
    await page.reload();
    await expect(page.getByText("Seleção enviada por Cliente E2E", { exact: false })).toBeVisible();
    await expect(page.getByRole("region", { name: "Compartilhamento da galeria" }).getByText("restore-e2e.png", { exact: true })).toBeVisible();
    const permissionResponse = page.waitForResponse(response => response.url().includes("set_gallery_share_downloads"));
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Liberar download dos originais" }).click();
    const permissionResult = await permissionResponse;
    expect(permissionResult.ok()).toBeTruthy();
    await expect(page.getByRole("status").filter({ hasText: "Download dos originais liberado" })).toBeVisible();
    const downloadGrant = await request.get(`/g/${token}/download/${photo.data!.id}`, { maxRedirects: 0 });
    expect(downloadGrant.status()).toBe(302);
    expect(downloadGrant.headers()["cache-control"]).toContain("no-store");
    const signedDownload = await request.get(downloadGrant.headers().location);
    expect(signedDownload.status()).toBe(200);
    expect(signedDownload.headers()["content-disposition"]).toContain("attachment");
  } finally {
    if (tenantId) {
      await cleanupTenantStorage(admin, tenantId);
      expect((await admin.from("tenants").delete().eq("id", tenantId)).error).toBeNull();
    }
    if (userId) await admin.auth.admin.deleteUser(userId);
  }
});
