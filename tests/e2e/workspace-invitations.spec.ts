import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const local = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
  encoding: "utf8", shell: process.platform === "win32",
}).replace(/^\uFEFF/, "")) as { API_URL: string; PUBLISHABLE_KEY: string; SERVICE_ROLE_KEY: string };
const admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false } });

test("workspace owners manage invitations, access, ownership, and team activity", async ({ page, browser }) => {
  const suffix = crypto.randomUUID();
  const ownerEmail = `owner-${suffix}@cartlio.test`;
  const inviteeEmail = `invitee-${suffix}@cartlio.test`;
  const signupEmail = `signup-${suffix}@cartlio.test`;
  const revokedEmail = `revoked-${suffix}@cartlio.test`;
  const ownerPassword = `Owner-${suffix}-Pass!`;
  const inviteePassword = `Invite-${suffix}-Pass!`;
  let ownerId: string | undefined;
  let inviteeId: string | undefined;
  let signupId: string | undefined;
  let tenantId: string | undefined;

  try {
    const owner = await admin.auth.admin.createUser({ email: ownerEmail, password: ownerPassword, email_confirm: true });
    const invitee = await admin.auth.admin.createUser({ email: inviteeEmail, password: inviteePassword, email_confirm: true });
    expect(owner.error).toBeNull();
    expect(invitee.error).toBeNull();
    ownerId = owner.data.user!.id;
    inviteeId = invitee.data.user!.id;

    const ownerClient = createClient(local.API_URL, local.PUBLISHABLE_KEY, { auth: { persistSession: false } });
    expect((await ownerClient.auth.signInWithPassword({ email: ownerEmail, password: ownerPassword })).error).toBeNull();
    const workspace = await ownerClient.rpc("create_workspace", {
      p_name: "Estúdio com equipe",
      p_slug: `equipe-${suffix}`,
    });
    expect(workspace.error).toBeNull();
    tenantId = workspace.data as string;

    await page.goto("/login");
    await page.getByLabel("E-mail", { exact: true }).fill(ownerEmail);
    await page.getByLabel("Senha", { exact: true }).fill(ownerPassword);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL("**/painel");
    await page.goto(`/painel/${tenantId}/equipe`);
    await expect(page.getByRole("heading", { name: "Equipe do estúdio" })).toBeVisible();

    await page.getByLabel("E-mail do colaborador").fill(inviteeEmail);
    await page.getByRole("button", { name: "Gerar link de convite" }).click();
    await expect(page.getByRole("status")).toContainText("Convite preparado");
    const invitationUrl = await page.getByLabel("Link de convite").inputValue();
    const invitationToken = new URL(invitationUrl).pathname.split("/").at(-1)!;
    expect(invitationToken).toMatch(/^[0-9a-f]{64}$/);

    const guest = await browser.newPage();
    const invitationResponse = await guest.goto(invitationUrl);
    expect(invitationResponse?.status()).toBe(200);
    await expect(guest.getByRole("heading", { name: "Estúdio com equipe" })).toBeVisible();
    await expect(guest.getByText(inviteeEmail, { exact: false })).toBeVisible();
    await expect(guest.getByText(/Como colaborador, você poderá gerenciar clientes, galerias, fotos, compartilhamentos e seleções\./)).toBeVisible();
    await guest.getByRole("link", { name: "Entrar com a conta convidada" }).click();
    await guest.waitForURL(url => url.pathname === "/login" && url.searchParams.get("next") === `/convite/${invitationToken}`);
    await guest.getByLabel("E-mail", { exact: true }).fill(inviteeEmail);
    await guest.getByLabel("Senha", { exact: true }).fill(inviteePassword);
    await guest.getByRole("button", { name: "Entrar", exact: true }).click();
    await guest.waitForURL(`**/convite/${invitationToken}`);
    await guest.getByRole("button", { name: "Aceitar convite" }).click();
    await guest.waitForURL(`**/painel/${tenantId}`);

    const membership = await admin.from("tenant_members").select("role").eq("tenant_id", tenantId).eq("user_id", inviteeId).single();
    expect(membership.error).toBeNull();
    expect(membership.data?.role).toBe("editor");
    await expect(guest.getByRole("link", { name: "Equipe", exact: true })).toHaveCount(0);
    await guest.goto(`/painel/${tenantId}/clientes`);
    await expect(guest.getByRole("heading", { name: "Clientes", exact: true })).toBeVisible();
    await guest.getByLabel("Nome", { exact: true }).fill("Cliente do colaborador");
    await guest.getByRole("button", { name: "Cadastrar cliente", exact: true }).click();
    await expect(guest.getByRole("status")).toContainText("Cliente cadastrado.");
    await guest.goto(`/painel/${tenantId}/marca`);
    await expect(guest.getByText("Somente o proprietário do workspace pode alterar a marca do estúdio.")).toBeVisible();
    await expect(guest.getByRole("button", { name: "Salvar identidade", exact: true })).toHaveCount(0);
    await guest.goto(`/painel/${tenantId}/equipe`);
    await expect(guest.getByRole("heading", { name: "Workspace não encontrado" })).toBeVisible();
    await expect(guest.getByRole("heading", { name: "Convites ativos" })).toHaveCount(0);

    await page.reload();
    const collaboratorRow = page.locator(".workspace-member-row").filter({ hasText: inviteeEmail });
    await expect(collaboratorRow).toBeVisible();
    await expect(collaboratorRow).toContainText("Colaborador");
    page.once("dialog", dialog => dialog.accept());
    await collaboratorRow.getByRole("button", { name: "Remover colaborador" }).click();
    await expect(page.locator(".workspace-member-row").filter({ hasText: inviteeEmail })).toHaveCount(0);
    const removedMembership = await admin.from("tenant_members").select("user_id")
      .eq("tenant_id", tenantId).eq("user_id", inviteeId).maybeSingle();
    expect(removedMembership.error).toBeNull();
    expect(removedMembership.data).toBeNull();
    await guest.goto(`/painel/${tenantId}`);
    await expect(guest.getByRole("heading", { name: "Página não encontrada" })).toBeVisible();

    await page.reload();
    await page.getByLabel("E-mail do colaborador").fill(signupEmail);
    await page.getByRole("button", { name: "Gerar link de convite" }).click();
    const signupInvitationUrl = await page.getByLabel("Link de convite").inputValue();
    const signupInvitationToken = new URL(signupInvitationUrl).pathname.split("/").at(-1)!;
    expect(signupInvitationToken).not.toBe(invitationToken);
    const publicInvitationClient = createClient(local.API_URL, local.PUBLISHABLE_KEY, { auth: { persistSession: false } });
    const publicInvitation = await publicInvitationClient.rpc("get_workspace_invitation", { p_token: signupInvitationToken });
    expect(publicInvitation.error).toBeNull();
    expect(publicInvitation.data).toMatchObject({ email: signupEmail });
    const signupGuest = await browser.newPage();
    const signupInviteResponse = await signupGuest.goto(signupInvitationUrl);
    expect(signupInviteResponse?.status()).toBe(200);
    await signupGuest.setViewportSize({ width: 320, height: 844 });
    const invitationLayout = await signupGuest.evaluate(() => ({
      viewportWidth: document.documentElement.clientWidth,
      contentWidth: document.documentElement.scrollWidth,
    }));
    expect(invitationLayout.contentWidth).toBeLessThanOrEqual(invitationLayout.viewportWidth);
    const createAccountLink = signupGuest.getByRole("link", { name: "Criar conta com esse e-mail" });
    if (await createAccountLink.count() !== 1) throw new Error(await signupGuest.locator("body").innerText());
    await createAccountLink.click();
    await signupGuest.waitForURL(url => url.pathname === "/cadastro" && url.searchParams.get("next") === `/convite/${signupInvitationToken}`);
    await signupGuest.getByLabel("E-mail", { exact: true }).fill(signupEmail);
    await signupGuest.getByLabel("Senha", { exact: true }).fill(`SignUp-${suffix}-Pass!`);
    await signupGuest.getByRole("button", { name: "Criar conta", exact: true }).click();
    await signupGuest.waitForURL(`**/convite/${signupInvitationToken}`);
    const users = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    expect(users.error).toBeNull();
    signupId = users.data.users.find(user => user.email === signupEmail)?.id;
    expect(signupId).toBeTruthy();
    await signupGuest.getByRole("button", { name: "Aceitar convite" }).click();
    await signupGuest.waitForURL(`**/painel/${tenantId}`);
    const newMembership = await admin.from("tenant_members").select("role").eq("tenant_id", tenantId).eq("user_id", signupId).single();
    expect(newMembership.error).toBeNull();
    expect(newMembership.data?.role).toBe("editor");

    await page.getByLabel("E-mail do colaborador").fill(revokedEmail);
    await page.getByRole("button", { name: "Gerar link de convite" }).click();
    const revokedInvitation = page.locator(".workspace-invitation-row").filter({ hasText: revokedEmail });
    await expect(revokedInvitation).toBeVisible();
    await revokedInvitation.getByRole("button", { name: "Revogar convite" }).click();
    await expect(page.locator(".workspace-invitation-row").filter({ hasText: revokedEmail })).toHaveCount(0);

    await page.getByLabel("Novo proprietário").selectOption(signupId!);
    await page.getByLabel("Entendo que deixarei de ser proprietário e perderei o gerenciamento da equipe.").check();
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Transferir propriedade", exact: true }).click();
    await page.waitForURL(`**/painel/${tenantId}`);
    await expect(page.getByRole("link", { name: "Equipe", exact: true })).toHaveCount(0);
    const previousOwnerMembership = await admin.from("tenant_members").select("role")
      .eq("tenant_id", tenantId).eq("user_id", ownerId).single();
    expect(previousOwnerMembership.error).toBeNull();
    expect(previousOwnerMembership.data?.role).toBe("editor");
    const newOwnerMembership = await admin.from("tenant_members").select("role")
      .eq("tenant_id", tenantId).eq("user_id", signupId).single();
    expect(newOwnerMembership.error).toBeNull();
    expect(newOwnerMembership.data?.role).toBe("owner");
    await signupGuest.reload();
    await expect(signupGuest.getByRole("link", { name: "Equipe", exact: true })).toBeVisible();
    await signupGuest.goto(`/painel/${tenantId}/equipe`);
    await expect(signupGuest.getByRole("heading", { name: "Equipe do estúdio" })).toBeVisible();
    await expect(signupGuest.locator(".workspace-team-activity")).toContainText("transferiu a propriedade");
    await expect(signupGuest.locator(".workspace-team-activity")).toContainText(`revogou um convite para ${revokedEmail}`);
    await expect(signupGuest.locator(".workspace-team-activity")).toContainText(inviteeEmail);

    await guest.close();
    await signupGuest.close();
  } finally {
    if (tenantId) await admin.from("tenants").delete().eq("id", tenantId);
    if (signupId) await admin.auth.admin.deleteUser(signupId);
    if (inviteeId) await admin.auth.admin.deleteUser(inviteeId);
    if (ownerId) await admin.auth.admin.deleteUser(ownerId);
  }
});
