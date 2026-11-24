import { quadricsEnv } from "./lib/quadrics-env.mjs";
import { maintenanceClient } from "./lib/maintenance-client.mjs";
import { createGalleryNotificationTransport, deliverGalleryNotifications } from "./lib/gallery-notification-mailer.mjs";

const args = process.argv.slice(2);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!["--local", "--remote"].includes(args[0]) || (args.length !== 1 &&
    (args.length !== 3 || args[1] !== "--share" || !uuidPattern.test(args[2])))) {
  throw new Error("Uso: node scripts/deliver-gallery-notifications.mjs --local|--remote [--share UUID]");
}

try {
  const mode = args[0];
  const client = maintenanceClient(mode);
  const { from, transport } = createGalleryNotificationTransport(mode);
  const result = await deliverGalleryNotifications({
    client,
    transport,
    from,
    shareId: args[2] ?? null,
    appUrl: quadricsEnv("APP_URL")?.trim() ?? (mode === "--local" ? "http://localhost:3000" : ""),
  });
  console.log(JSON.stringify(result));
  if (result.retry || result.failed) process.exitCode = 1;
} catch {
  console.error("Entrega de notificações não concluída. Confira o Supabase e a configuração SMTP.");
  process.exitCode = 1;
}
