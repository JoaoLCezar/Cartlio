import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const local = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
  encoding: "utf8", shell: process.platform === "win32",
}).replace(/^\uFEFF/, "")) as { API_URL: string; PUBLISHABLE_KEY: string; SERVICE_ROLE_KEY: string };
const admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false } });

test("searches and links customers from the gallery form and dashboard filter", async ({ page }) => {
  const suffix = crypto.randomUUID();
  const email = `customer-picker-${suffix}@cartlio.test`;
  const password = `Picker-${suffix}-Pass!`;
  let userId: string | undefined;
  let tenantId: string | undefined;

  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    userId = created.data.user!.id;
    const member = createClient(local.API_URL, local.PUBLISHABLE_KEY, { auth: { persistSession: false } });
    expect((await member.auth.signInWithPassword({ email, password })).error).toBeNull();
    const workspace = await member.rpc("create_workspace", { p_name: "Busca de clientes", p_slug: `pick-${suffix}` });
    expect(workspace.error).toBeNull();
    tenantId = workspace.data as string;
    const customer = await member.from("customers").insert({ tenant_id: tenantId, name: "Cliente para busca" }).select("id").single();
    expect(customer.error).toBeNull();

    await page.goto("/login");
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL("**/painel");

    await page.goto(`/painel/${tenantId}/galerias/nova`);
    const galleryCustomer = page.getByRole("combobox", { name: "Cliente principal", exact: true });
    await galleryCustomer.fill("Cliente para");
    await page.getByRole("listbox").getByRole("button", { name: "Cliente para busca", exact: true }).click();
    await expect(page.locator('input[type="hidden"][name="customer_id"]')).toHaveValue(customer.data!.id);
    await page.getByLabel("Título", { exact: true }).fill("Ensaio da busca");
    await page.getByRole("button", { name: "Criar galeria", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/painel/${tenantId}/galerias/[0-9a-f-]+$`));
    await expect(page.getByRole("combobox", { name: "Cliente principal", exact: true })).toHaveValue("Cliente para busca");

    const savedGallery = await member.from("galleries").select("id, customer_id").eq("tenant_id", tenantId).eq("title", "Ensaio da busca").single();
    expect(savedGallery.error).toBeNull();
    expect(savedGallery.data?.customer_id).toBe(customer.data!.id);

    await page.goto(`/painel/${tenantId}`);
    const dashboardCustomer = page.getByRole("combobox", { name: "Cliente", exact: true });
    await dashboardCustomer.fill("Cliente para");
    await page.getByRole("listbox").getByRole("button", { name: "Cliente para busca", exact: true }).click();
    await page.getByRole("button", { name: "Filtrar", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`customer=${customer.data!.id}`));
    await expect(page.getByRole("heading", { name: "Ensaio da busca", level: 2 })).toBeVisible();
  } finally {
    if (tenantId) await admin.from("tenants").delete().eq("id", tenantId);
    if (userId) await admin.auth.admin.deleteUser(userId);
  }
});
