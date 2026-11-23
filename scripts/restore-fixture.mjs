import { quadricsEnv } from "./lib/quadrics-env.mjs";
import { appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseLocalSupabaseStatus(rawStatus) {
  let status;
  try {
    status = JSON.parse(rawStatus.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("Supabase CLI did not return valid local status.");
  }
  let apiUrl;
  try {
    apiUrl = new URL(status.API_URL);
  } catch {
    throw new Error("Supabase CLI did not return a valid API URL.");
  }
  if (apiUrl.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(apiUrl.hostname)) {
    throw new Error("The restore fixture only accepts a local Supabase endpoint.");
  }
  const serviceRoleKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
  if (!serviceRoleKey || !status.PUBLISHABLE_KEY) {
    throw new Error("Supabase CLI did not return the local keys required by the fixture.");
  }
  return { apiUrl: apiUrl.origin, serviceRoleKey, publishableKey: status.PUBLISHABLE_KEY };
}

async function createRestoreFixture() {
  if (quadricsEnv("CI_RESTORE_FIXTURE") !== "1" || !process.env.GITHUB_OUTPUT) {
    throw new Error("This fixture can only run in the explicitly enabled CI workflow.");
  }
  const rawStatus = execFileSync(process.execPath, [join(projectRoot, "node_modules", "supabase", "dist", "supabase.js"), "status", "--output", "json"], {
    encoding: "utf8",
    cwd: projectRoot,
    windowsHide: true,
  });
  const { apiUrl, serviceRoleKey, publishableKey } = parseLocalSupabaseStatus(rawStatus);
  const suffix = randomUUID();
  const email = `restore-fixture-${suffix}@cartlio.test`;
  const password = `Restore-${suffix}-Pass!`;
  const admin = createClient(apiUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let userId;
  let tenantId;
  let stage = "create account";

  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error("Could not create the synthetic restore account.");
    userId = created.data.user.id;
    stage = "authenticate account";
    const member = createClient(apiUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const signedIn = await member.auth.signInWithPassword({ email, password });
    if (signedIn.error) throw new Error("Could not authenticate the synthetic restore account.");
    stage = "create workspace";
    const workspace = await member.rpc("create_workspace", {
      p_name: `Restore fixture ${suffix.slice(0, 8)}`,
      p_slug: `restore-fixture-${suffix.slice(0, 16)}`,
    });
    if (workspace.error || typeof workspace.data !== "string") throw new Error("Could not create the synthetic restore workspace.");
    tenantId = workspace.data;
    stage = "write workflow outputs";
    await appendFile(process.env.GITHUB_OUTPUT, `email=${email}\npassword=${password}\ntenant_id=${tenantId}\n`, { encoding: "utf8", mode: 0o600 });
    if (process.env.CI === "true") {
      console.log(`::add-mask::${email}`);
      console.log(`::add-mask::${password}`);
    }
    console.log("Synthetic restore fixture created in the local Supabase instance.");
  } catch {
    if (tenantId) await admin.from("tenants").delete().eq("id", tenantId);
    if (userId) await admin.auth.admin.deleteUser(userId);
    throw new Error(`Could not prepare the synthetic restore fixture during ${stage}.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await createRestoreFixture();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Restore fixture creation failed.");
    process.exitCode = 1;
  }
}
