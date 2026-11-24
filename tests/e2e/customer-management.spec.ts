import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const local = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
  encoding: "utf8", shell: process.platform === "win32",
}).replace(/^\uFEFF/, "")) as { API_URL: string; PUBLISHABLE_KEY: string; SERVICE_ROLE_KEY: string };
const admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false } });

test("customer deletion requires confirmation and respects gallery links", async ({ page, browser }) => {
  const suffix = crypto.randomUUID();
  const email = `customers-${suffix}@cartlio.test`;
  const password = `Customer-${suffix}-Pass!`;
  let userId: string | undefined;
  let tenantId: string | undefined;
  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    userId = created.data.user!.id;
    const member = createClient(local.API_URL, local.PUBLISHABLE_KEY, { auth: { persistSession: false } });
    expect((await member.auth.signInWithPassword({ email, password })).error).toBeNull();
    const workspace = await member.rpc("create_workspace", { p_name: "Gestão de clientes", p_slug: `customers-${suffix}` });
    expect(workspace.error).toBeNull();
    tenantId = workspace.data as string;

    const guest = await browser.newPage();
    await guest.goto(`/painel/${tenantId}/clientes/export`);
    await expect(guest).toHaveURL(/\/login$/);
    await guest.close();

    await page.goto("/login");
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("Senha", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL("**/painel");
    await page.goto(`/painel/${tenantId}`);
    await expect(page.getByRole("heading", { name: "Organize seu primeiro trabalho" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Criar primeira galeria" })).toHaveAttribute("href", `/painel/${tenantId}/galerias/nova`);
    await expect(page.getByRole("link", { name: "Abrir clientes" })).toHaveAttribute("href", `/painel/${tenantId}/clientes`);
    await page.goto(`/painel/${tenantId}/clientes`);
    await page.getByLabel("Nome", { exact: true }).fill("Cliente de teste");
    await page.getByLabel("E-mail (opcional)", { exact: true }).fill("cliente@example.test");
    await page.getByLabel("WhatsApp (opcional)", { exact: true }).fill("+55 (11) 98765-4321");
    await page.getByRole("button", { name: "Cadastrar cliente", exact: true }).click();
    const customer = page.locator("details").filter({ hasText: "Cliente de teste" });
    await expect(customer).toBeVisible();
    await page.locator("section").first().getByLabel("Nome", { exact: true }).fill("Cliente alternativo");
    await page.locator("section").first().getByLabel("E-mail (opcional)", { exact: true }).fill("alternativo@example.test");
    await page.getByRole("button", { name: "Cadastrar cliente", exact: true }).click();
    const alternativeCustomer = page.locator("details").filter({ hasText: "Cliente alternativo" });
    await expect(alternativeCustomer).toBeVisible();
    await expect(alternativeCustomer.locator("summary").getByText("Nenhuma galeria vinculada", { exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "Contato", exact: true }).selectOption("missing-whatsapp");
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/painel/${tenantId}/clientes\\?q=&contact=missing-whatsapp`));
    await expect(customer).toHaveCount(0);
    await expect(alternativeCustomer).toBeVisible();
    await alternativeCustomer.locator("summary").click();
    await alternativeCustomer.getByLabel("WhatsApp (opcional)", { exact: true }).fill("+55 (31) 90000-1234");
    await alternativeCustomer.getByRole("button", { name: "Salvar cliente", exact: true }).click();
    await expect(alternativeCustomer).toHaveCount(0);
    await page.getByRole("combobox", { name: "Contato", exact: true }).selectOption("all");
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    await page.getByRole("combobox", { name: "Contato", exact: true }).selectOption("missing-email");
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    await expect(page.getByText("Nenhum cliente encontrado para os filtros atuais.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Limpar", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Limpar", exact: true }).click();
    await expect(customer).toBeVisible();
    await expect(alternativeCustomer).toBeVisible();
    await page.getByLabel("Buscar por nome, e-mail ou WhatsApp").fill("cliente@example.test");
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/painel/${tenantId}/clientes\\?q=cliente%40example.test`));
    await expect(customer).toBeVisible();
    await expect(page.locator("details").filter({ hasText: "Cliente alternativo" })).toHaveCount(0);
    await page.getByLabel("Buscar por nome, e-mail ou WhatsApp").fill("example.test");
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    await expect(customer).toBeVisible();
    await expect(page.locator("details").filter({ hasText: "Cliente alternativo" })).toBeVisible();
    await page.getByLabel("Buscar por nome, e-mail ou WhatsApp").fill("%example.test");
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    await expect(page.getByText("Nenhum cliente encontrado para os filtros atuais.")).toBeVisible();
    await page.getByLabel("Buscar por nome, e-mail ou WhatsApp").fill("cliente inexistente");
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    await expect(page.getByText("Nenhum cliente encontrado para os filtros atuais.")).toBeVisible();
    await page.getByLabel("Buscar por nome, e-mail ou WhatsApp").fill("Cliente de teste");
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    await expect(customer).toBeVisible();
    await customer.locator("summary").click();
    await customer.getByLabel("WhatsApp (opcional)", { exact: true }).fill("+55 (21) 91234-5678");
    await customer.getByRole("button", { name: "Salvar cliente", exact: true }).click();
    await expect(customer.locator("summary")).toContainText("+5521912345678");
    await page.getByLabel("Buscar por nome, e-mail ou WhatsApp").fill("+55 (21) 91234-5678");
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    await expect(customer).toBeVisible();
    await expect(page.locator("details").filter({ hasText: "Cliente alternativo" })).toHaveCount(0);
    const [customerExport] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Exportar CSV" }).click(),
    ]);
    expect(customerExport.suggestedFilename()).toMatch(/^clientes-\d{4}-\d{2}-\d{2}\.csv$/);
    const customerExportPath = await customerExport.path();
    expect(customerExportPath).toBeTruthy();
    const customerCsv = await readFile(customerExportPath!, "utf8");
    expect(customerCsv).toContain('"Cliente de teste"');
    expect(customerCsv).toContain("\"'+5521912345678\"");
    expect(customerCsv).not.toContain("Cliente alternativo");

    const inserted = await member.from("customers").select("id, whatsapp_phone").eq("tenant_id", tenantId).eq("name", "Cliente de teste").single();
    expect(inserted.error).toBeNull();
    expect(inserted.data?.whatsapp_phone).toBe("+5521912345678");
    const gallery = await member.from("galleries").insert({
      tenant_id: tenantId, customer_id: inserted.data!.id, title: "Ensaio vinculado", slug: `ensaio-${suffix.slice(0, 8)}`,
    }).select("id").single();
    expect(gallery.error).toBeNull();

    await page.reload();
    await expect(customer.locator("summary").getByText("1 galeria vinculada", { exact: true })).toBeVisible();
    await customer.locator("summary").click();
    await customer.getByRole("link", { name: "Ver galerias de Cliente de teste" }).click();
    await expect(page).toHaveURL(new RegExp(`/painel/${tenantId}\\?customer=${inserted.data!.id}`));
    await expect(page.getByRole("heading", { name: "Ensaio vinculado", level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Outra galeria", level: 2 })).toHaveCount(0);
    await page.goto(`/painel/${tenantId}/clientes?q=Cliente+de+teste`);
    await expect(customer).toBeVisible();
    await customer.locator("summary").click();

    page.once("dialog", dialog => dialog.accept());
    await customer.getByRole("button", { name: "Excluir cliente" }).click();
    await expect(customer.getByRole("alert")).toContainText("Desvincule este cliente das galerias");

    expect((await member.from("galleries").update({ customer_id: null }).eq("id", gallery.data!.id)).error).toBeNull();
    page.once("dialog", dialog => dialog.accept());
    await customer.getByRole("button", { name: "Excluir cliente" }).click();
    await expect(page.locator("details").filter({ hasText: "Cliente de teste" })).toHaveCount(0);
  } finally {
    if (tenantId) await admin.from("tenants").delete().eq("id", tenantId);
    if (userId) await admin.auth.admin.deleteUser(userId);
  }
});
