import { expect, test } from "@playwright/test";

test("public gallery JSON routes reject oversized bodies before processing them", async ({ request }) => {
  const token = "0".repeat(64);
  const padding = "x".repeat(16 * 1024);

  const unlock = await request.post(`/g/${token}/unlock`, { data: { pin: "123456", padding } });
  expect(unlock.status()).toBe(413);
  expect(await unlock.json()).toEqual({ error: "Solicitação muito grande." });

  const selection = await request.post(`/g/${token}/selection`, { data: { action: "clear", padding } });
  expect(selection.status()).toBe(413);
  expect(await selection.json()).toEqual({ error: "Solicitação muito grande." });
});
