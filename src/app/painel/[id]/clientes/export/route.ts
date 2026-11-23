import { customerCsv, type CustomerCsvRow } from "@/lib/customer-csv";
import { customerSearchFilter, parseCustomerContactFilter } from "@/lib/customer-search";
import { requireWorkspace } from "@/lib/workspace";

const noStore = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff" };
const batchSize = 500;
const maxExportRows = 25_000;

function textResponse(message: string, status: number) {
  return new Response(message, { status, headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" } });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireWorkspace(id);
  const search = new URL(request.url).searchParams;
  const query = search.get("q")?.trim().slice(0, 120) ?? "";
  const contactFilter = parseCustomerContactFilter(search.get("contact"));
  const searchFilter = customerSearchFilter(query);

  let countQuery = supabase.from("customers").select("id", { count: "exact", head: true }).eq("tenant_id", id);
  if (searchFilter) countQuery = countQuery.or(searchFilter);
  if (contactFilter === "missing-email") countQuery = countQuery.is("email", null);
  if (contactFilter === "missing-whatsapp") countQuery = countQuery.is("whatsapp_phone", null);
  const { count, error: countError } = await countQuery;
  if (countError) return textResponse("Não foi possível exportar os clientes.", 500);
  if ((count ?? 0) > maxExportRows) return textResponse("A exportação está limitada a 25.000 clientes. Aplique um filtro e tente novamente.", 413);

  const customers: CustomerCsvRow[] = [];
  for (let offset = 0; ; offset += batchSize) {
    let customersQuery = supabase.from("customers")
      .select("name, email, whatsapp_phone, created_at")
      .eq("tenant_id", id)
      .order("name")
      .order("id")
      .range(offset, offset + batchSize - 1);
    if (searchFilter) customersQuery = customersQuery.or(searchFilter);
    if (contactFilter === "missing-email") customersQuery = customersQuery.is("email", null);
    if (contactFilter === "missing-whatsapp") customersQuery = customersQuery.is("whatsapp_phone", null);
    const { data, error } = await customersQuery;
    if (error || !data) return textResponse("Não foi possível exportar os clientes.", 500);
    if (customers.length + data.length > maxExportRows) return textResponse("A exportação está limitada a 25.000 clientes. Aplique um filtro e tente novamente.", 413);
    customers.push(...data);
    if (data.length < batchSize) break;
  }

  const filename = `clientes-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(customerCsv(customers), {
    headers: {
      ...noStore,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
