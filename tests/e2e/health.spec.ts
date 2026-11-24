import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

test("liveness and readiness report web, database, and private storage state", async ({ request }) => {
  const home = await request.get("/");
  expect(home.status()).toBe(200);
  const homeHtml = await home.text();
  expect(homeHtml).toContain("receber uma seleção do cliente ou entregar todas as fotos");
  expect(homeHtml).toContain("disponibilize a galeria completa em um só link");
  expect(home.headers()["x-content-type-options"]).toBe("nosniff");
  expect(home.headers()["x-frame-options"]).toBe("DENY");
  expect(home.headers()["referrer-policy"]).toBe("no-referrer");
  expect(home.headers()["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
  expect(home.headers()["strict-transport-security"]).toBe("max-age=31536000");
  const csp = home.headers()["content-security-policy"];
  expect(csp).toContain("default-src 'self'");
  expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(csp).toContain("style-src-attr 'unsafe-inline'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain("'unsafe-eval'");

  const liveness = await request.get("/api/health");
  expect(liveness.status()).toBe(200);
  expect(liveness.headers()["cache-control"]).toBe("no-store");
  expect(liveness.headers()["x-content-type-options"]).toBe("nosniff");
  expect(await liveness.json()).toMatchObject({ status: "ok", service: "cartlio-web" });

  const readiness = await request.get("/api/ready");
  expect(readiness.status()).toBe(200);
  expect(readiness.headers()["cache-control"]).toBe("no-store");
  expect(readiness.headers()["x-frame-options"]).toBe("DENY");
  expect(await readiness.json()).toEqual({
    status: "ready", checks: { database: "ok", storage: "ok", clientIp: "ok" },
  });

  const appUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3310";
  const probeOutput = execFileSync(process.execPath, [
    "scripts/check-readiness.mjs", "--url", new URL("/api/ready", appUrl).toString(),
  ], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  expect(probeOutput.trim()).toBe("Readiness ready (database=ok, storage=ok, client_ip=ok)");

  const privateGallery = await request.get(`/g/${"0".repeat(64)}`);
  expect(privateGallery.status()).toBe(404);
  expect(privateGallery.headers()["cache-control"]).toContain("no-store");
  expect(privateGallery.headers()["referrer-policy"]).toBe("no-referrer");
  expect(privateGallery.headers()["x-robots-tag"]).toContain("noindex");
  expect(privateGallery.headers()["x-content-type-options"]).toBe("nosniff");
});
