import type { SupabaseClient } from "@supabase/supabase-js";

export function cleanupTenantStorage(
  client: SupabaseClient,
  tenantId: string,
): Promise<Record<string, number>>;
