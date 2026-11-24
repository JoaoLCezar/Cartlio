import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const local = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
  encoding: "utf8", shell: process.platform === "win32",
}).replace(/^\uFEFF/, "")) as { API_URL: string; PUBLISHABLE_KEY: string; SERVICE_ROLE_KEY: string };
const admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false } });

test("customer and gallery catalogs paginate while retaining filters", async ({ page }) => {
  const suffix = crypto.randomUUID();
  const email = `pagination-${suffix}@cartlio.test`;
  const password = `Pagination-${suffix}-Pass!`;
  let userId: string | undefined;
  let tenantId: string | undefined;
  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    userId = created.data.user!.id;
    const member = createClient(local.API_URL, local.PUBLISHABLE_KEY, { auth: { persistSession: false } });
    expect((await member.auth.signInWithPassword({ email, password })).error).toBeNull();
    const workspace = await member.rpc("create_workspace", { p_name: "Paginação", p_slug: `pagination-${suffix}` });
    expect(workspace.error).toBeNull();
    tenantId = workspace.data as string;

    const customers = await member.from("customers").insert(Array.from({ length: 27 }, (_, index) => ({
      tenant_id: tenantId!, name: `Cliente ${String(index + 1).padStart(2, "0")}`, email: null,
    })));
    expect(customers.error).toBeNull();
    const galleries = await member.from("galleries").insert(Array.from({ length: 57 }, (_, index) => ({
      tenant_id: tenantId!,
      title: `Sessao ${String(index + 1).padStart(2, "0")}`,
      slug: `sessao-${String(index + 1).padStart(2, "0")}`,
      status: index < 30 ? "published" : "draft",
    })));
    expect(galleries.error).toBeNull();

    await page.goto("/login");
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL("**/painel");

    await page.goto(`/painel/${tenantId}`);
    await expect(page.locator("ul.gallery-dashboard-grid > li")).toHaveCount(25);
    await expect(page.getByRole("navigation", { name: "Paginação de galerias" })).toContainText("Página 1 de 3");
    await page.getByRole("link", { name: "Próxima" }).click();
    await expect(page).toHaveURL(new RegExp(`/painel/${tenantId}\\?page=2`));
    await expect(page.locator("ul.gallery-dashboard-grid > li")).toHaveCount(25);
    await page.goto(`/painel/${tenantId}?page=999`);
    await expect(page).toHaveURL(new RegExp(`/painel/${tenantId}\\?page=3`));
    await expect(page.locator("ul.gallery-dashboard-grid > li")).toHaveCount(7);
    await page.getByRole("link", { name: "Anterior" }).click();
    await page.getByLabel("Buscar por título").fill("Sessao");
    await page.getByLabel("Status").selectOption("published");
    await page.getByRole("button", { name: "Filtrar", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/painel/${tenantId}\\?q=Sessao&status=published`));
    await expect(page.locator("ul.gallery-dashboard-grid > li")).toHaveCount(25);
    await page.getByRole("link", { name: "Próxima" }).click();
    await expect(page).toHaveURL(new RegExp(`/painel/${tenantId}\\?q=Sessao&status=published&page=2`));
    await expect(page.locator("ul.gallery-dashboard-grid > li")).toHaveCount(5);

    await page.goto(`/painel/${tenantId}`);
    await page.getByLabel("Buscar por título").fill("Sessao%");
    await page.getByRole("button", { name: "Filtrar", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/painel/${tenantId}\\?q=Sessao%25`));
    await expect(page.getByText("Nenhuma galeria encontrada com estes filtros.")).toBeVisible();
    await expect(page.locator("ul.gallery-dashboard-grid > li")).toHaveCount(0);

    await page.goto(`/painel/${tenantId}/clientes`);
    await expect(page.locator("details")).toHaveCount(25);
    await page.getByRole("link", { name: "Próxima" }).click();
    await expect(page).toHaveURL(new RegExp(`/painel/${tenantId}/clientes\\?page=2`));
    await expect(page.locator("details")).toHaveCount(2);
    await page.getByLabel("Buscar por nome").fill("Cliente 27");
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/painel/${tenantId}/clientes\\?q=Cliente\\+27`));
    await expect(page.locator("details")).toHaveCount(1);
    await expect(page.locator("details").first()).toContainText("Cliente 27");
  } finally {
    if (tenantId) await admin.from("tenants").delete().eq("id", tenantId);
    if (userId) await admin.auth.admin.deleteUser(userId);
  }
});
