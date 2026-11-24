import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

const local = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
  encoding: "utf8", shell: process.platform === "win32",
}).replace(/^\uFEFF/, "")) as {
  API_URL: string;
  PUBLISHABLE_KEY: string;
  SERVICE_ROLE_KEY: string;
  MAILPIT_URL: string;
};
const admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false } });

test("password recovery uses a generic email response and updates the account through its callback", async ({ page, request }) => {
  const suffix = crypto.randomUUID();
  const email = `recovery-${suffix}@cartlio.test`;
  const oldPassword = `Old-${suffix}-Pass!`;
  const newPassword = `New-${suffix}-Pass!`;
  let userId: string | undefined;
  try {
    const created = await admin.auth.admin.createUser({ email, password: oldPassword, email_confirm: true });
    expect(created.error).toBeNull();
    userId = created.data.user!.id;

    await page.goto("/recuperar-senha");
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Enviar link de recuperação" }).click();
    await expect(page.getByRole("status")).toContainText("Se houver uma conta para esse e-mail");

    let messageId: string | null = null;
    await expect.poll(async () => {
      const response = await request.get(`${local.MAILPIT_URL}/api/v1/messages`);
      if (!response.ok()) return false;
      const inbox = await response.json() as { messages: Array<{ ID: string; To: Array<{ Address: string }> }> };
      messageId = inbox.messages.find((message) =>
        message.To.some((recipient) => recipient.Address.toLowerCase() === email.toLowerCase()),
      )?.ID ?? null;
      return messageId !== null;
    }, { timeout: 15_000 }).toBe(true);

    const messageResponse = await request.get(`${local.MAILPIT_URL}/api/v1/message/${messageId}`);
    expect(messageResponse.ok()).toBeTruthy();
    const message = await messageResponse.json() as { Text: string };
    const actionLink = message.Text.match(/https?:\/\/[^\s"<>]+/)?.[0];
    expect(actionLink).toBeTruthy();
    await page.goto(actionLink!);
    await expect(page).toHaveURL(/\/redefinir-senha$/);
    await page.getByLabel("Nova senha", { exact: true }).fill(newPassword);
    await page.getByLabel("Confirme a nova senha", { exact: true }).fill(newPassword);
    await page.getByRole("button", { name: "Salvar nova senha" }).click();
    await page.waitForURL("**/painel");

    const verifier = createClient(local.API_URL, local.PUBLISHABLE_KEY, { auth: { persistSession: false } });
    expect((await verifier.auth.signInWithPassword({ email, password: newPassword })).error).toBeNull();
    expect((await verifier.auth.signInWithPassword({ email, password: oldPassword })).error).not.toBeNull();
  } finally {
    if (userId) await admin.auth.admin.deleteUser(userId);
  }
});
