import { NextResponse } from "next/server";
import { customerSearchFilter } from "@/lib/customer-search";
import { requireWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const responseHeaders = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" };

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: tenantId } = await params;
  const { supabase } = await requireWorkspace(tenantId);
  const query = new URL(request.url).searchParams.get("q")?.trim().slice(0, 120) ?? "";
  if ([...query].length < 2) return NextResponse.json({ customers: [] }, { headers: responseHeaders });

  const searchFilter = customerSearchFilter(query);
  if (!searchFilter) return NextResponse.json({ customers: [] }, { headers: responseHeaders });

  const { data, error } = await supabase.from("customers").select("id, name")
    .eq("tenant_id", tenantId).or(searchFilter).order("name").order("id").limit(20);
  if (error) return NextResponse.json({ error: "Não foi possível buscar os clientes." }, { status: 500, headers: responseHeaders });

  return NextResponse.json({ customers: data ?? [] }, { headers: responseHeaders });
}
