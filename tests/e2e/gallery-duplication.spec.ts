import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const local = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
  encoding: "utf8", shell: process.platform === "win32",
}).replace(/^\uFEFF/, "")) as { API_URL: string; PUBLISHABLE_KEY: string; SERVICE_ROLE_KEY: string };
const admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false } });

test("duplicates gallery setup as a clean draft with a unique address", async ({ page }) => {
  const suffix = crypto.randomUUID();
  const email = `gallery-copy-${suffix}@cartlio.test`;
  const password = `Gallery-${suffix}-Pass!`;
  let userId: string | undefined;
  let tenantId: string | undefined;

  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    userId = created.data.user!.id;
    const member = createClient(local.API_URL, local.PUBLISHABLE_KEY, { auth: { persistSession: false } });
    expect((await member.auth.signInWithPassword({ email, password })).error).toBeNull();
    const workspace = await member.rpc("create_workspace", { p_name: "Galerias modelo", p_slug: `copy-${suffix.slice(0, 8)}` });
    expect(workspace.error).toBeNull();
    tenantId = workspace.data as string;

    const customer = await member.from("customers").insert({ tenant_id: tenantId, name: "Cliente original", email: "cliente@example.test" }).select("id").single();
    expect(customer.error).toBeNull();
    const sourceSlug = `ensaio-${suffix.slice(0, 8)}`;
    const source = await member.from("galleries").insert({
      tenant_id: tenantId,
      customer_id: customer.data!.id,
      title: "Ensaio recorrente",
      slug: sourceSlug,
      description: "Instruções reutilizáveis para este tipo de trabalho.",
      status: "published",
    }).select("id").single();
    expect(source.error).toBeNull();
    const photoId = crypto.randomUUID();
    const photo = await admin.from("photos").insert({
      id: photoId,
      tenant_id: tenantId,
      gallery_id: source.data!.id,
      object_path: `${tenantId}/${source.data!.id}/${photoId}.jpg`,
      original_filename: "foto-original.jpg",
      content_type: "image/jpeg",
      byte_size: 1024,
      created_by: userId,
      processing_status: "ready",
      width: 1200,
      height: 800,
    });
    expect(photo.error).toBeNull();
    const share = await member.rpc("create_gallery_share", {
      p_tenant_id: tenantId,
      p_gallery_id: source.data!.id,
      p_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      p_selection_limit: 20,
      p_share_mode: "selection",
      p_pin: null,
    });
    expect(share.error).toBeNull();
    const invalidatedPhoto = await admin.from("photos").update({ processing_status: "invalid" }).eq("id", photoId);
    expect(invalidatedPhoto.error).toBeNull();

    await page.goto("/login");
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL("**/painel");
    const sourcePath = `/painel/${tenantId}/galerias/${source.data!.id}`;
    await page.goto(sourcePath);
    await page.getByRole("button", { name: "Criar cópia como rascunho" }).click();
    await page.waitForURL(url => url.pathname !== sourcePath);
    await expect(page).toHaveURL(new RegExp(`/painel/${tenantId}/galerias/[0-9a-f-]+$`));

    let copyId = new URL(page.url()).pathname.split("/").at(-1)!;
    expect(copyId).not.toBe(source.data!.id);
    await expect(page.locator('input[name="title"]')).toHaveValue("Cópia de Ensaio recorrente");
    await expect(page.locator('input[name="slug"]')).toHaveValue(`${sourceSlug}-copia`);
    await expect(page.locator('textarea[name="description"]')).toHaveValue("Instruções reutilizáveis para este tipo de trabalho.");
    await expect(page.locator('select[name="status"]')).toHaveValue("draft");
    await expect(page.locator('input[type="hidden"][name="customer_id"]')).toHaveValue("");

    const firstCopy = await member.from("galleries").select("id, status, customer_id").eq("id", copyId).single();
    expect(firstCopy.error).toBeNull();
    expect(firstCopy.data).toMatchObject({ status: "draft", customer_id: null });
    const firstCopyShares = await member.from("gallery_shares").select("id", { count: "exact", head: true }).eq("gallery_id", copyId);
    const firstCopyPhotos = await member.from("photos").select("id", { count: "exact", head: true }).eq("gallery_id", copyId);
    const sourcePhotos = await member.from("photos").select("id", { count: "exact", head: true }).eq("gallery_id", source.data!.id);
    expect(firstCopyShares.error).toBeNull();
    expect(firstCopyShares.count).toBe(0);
    expect(firstCopyPhotos.error).toBeNull();
    expect(firstCopyPhotos.count).toBe(0);
    expect(sourcePhotos.error).toBeNull();
    expect(sourcePhotos.count).toBe(1);

    await page.goto(sourcePath);
    await page.getByRole("button", { name: "Criar cópia como rascunho" }).click();
    await page.waitForURL(url => url.pathname !== sourcePath);
    await expect(page).toHaveURL(new RegExp(`/painel/${tenantId}/galerias/[0-9a-f-]+$`));
    copyId = new URL(page.url()).pathname.split("/").at(-1)!;
    await expect(page.locator('input[name="slug"]')).toHaveValue(`${sourceSlug}-copia-2`);
  } finally {
    if (tenantId) await admin.from("tenants").delete().eq("id", tenantId);
    if (userId) await admin.auth.admin.deleteUser(userId);
  }
});
