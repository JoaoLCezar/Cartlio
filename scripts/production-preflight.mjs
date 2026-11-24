import { validateProductionConfig } from "./lib/production-config.mjs";

const errors = validateProductionConfig();
if (errors.length) {
  process.stderr.write(`Production configuration is incomplete:\n${errors.map(error => `- ${error}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  await import("../server.js");
}
