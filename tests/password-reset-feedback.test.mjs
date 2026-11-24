import assert from "node:assert/strict";
import test from "node:test";
import { passwordResetFeedback } from "../src/lib/password-reset-feedback.ts";

test("keeps the generic password-recovery response when Supabase accepts the request", () => {
  const response = passwordResetFeedback(null);
  assert.equal(typeof response.success, "string");
  assert.equal(response.error, undefined);
});

test("reports service failure without revealing whether the email has an account", () => {
  const response = passwordResetFeedback(new Error("internal provider detail"));
  assert.equal(typeof response.error, "string");
  assert.equal(response.success, undefined);
  assert.equal(response.error?.includes("internal provider detail"), false);
});
