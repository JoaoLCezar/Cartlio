import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/workspace";
import { ActionForm } from "@/components/action-form";
import { DeleteCustomerForm } from "@/components/delete-customer-form";
import { Pagination } from "@/components/pagination";
import { customerSearchFilter, parseCustomerContactFilter } from "@/lib/customer-search";
import { deleteCustomer, saveCustomer } from "../actions";

const pageSize = 25;

type CustomersPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string | string[]; contact?: string | string[]; page?: string | string[] }>;
};

export default async function CustomersPage({ params, searchParams }: CustomersPageProps) {
  const [{ id }, search] = await Promise.all([params, searchParams]);
  const query = (Array.isArray(search.q) ? search.q[0] : search.q)?.trim().slice(0, 120) ?? "";
  const requestedContact = Array.isArray(search.contact) ? search.contact[0] : search.contact;
  const contactFilter = parseCustomerContactFilter(requestedContact);
  const hasCustomerFilters = Boolean(query) || contactFilter !== "all";
  const searchFilter = customerSearchFilter(query);
  const pageValue = Array.isArray(search.page) ? search.page[0] : search.page;
  const parsedPage = Number(pageValue);
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 && parsedPage <= 10_000 ? parsedPage : 1;
  const offset = (page - 1) * pageSize;
  const { supabase } = await requireWorkspace(id);
  const pageHref = (targetPage: number) => {
    const search = new URLSearchParams();
    if (query) search.set("q", query);
    if (contactFilter !== "all") search.set("contact", contactFilter);
    search.set("page", String(targetPage));
    return `/painel/${id}/clientes?${search.toString()}`;
  };
  let totalItems = 0;
  if (page > 1) {
    let countQuery = supabase.from("customers").select("id", { count: "exact", head: true }).eq("tenant_id", id);
    if (searchFilter) countQuery = countQuery.or(searchFilter);
    if (contactFilter === "missing-email") countQuery = countQuery.is("email", null);
    if (contactFilter === "missing-whatsapp") countQuery = countQuery.is("whatsapp_phone", null);
    const { count, error } = await countQuery;
    if (error) throw new Error("N\u00e3o foi poss\u00edvel carregar os clientes.");
    totalItems = count ?? 0;
    const pageCount = Math.ceil(totalItems / pageSize);
    if (page > pageCount) redirect(pageHref(Math.max(pageCount, 1)));
  }
  let customersQuery = supabase.from("customers").select("id, name, email, whatsapp_phone, galleries(count)", page === 1 ? { count: "exact" } : {}).eq("tenant_id", id).order("name").order("id").range(offset, offset + pageSize - 1);
  if (searchFilter) customersQuery = customersQuery.or(searchFilter);
  if (contactFilter === "missing-email") customersQuery = customersQuery.is("email", null);
  if (contactFilter === "missing-whatsapp") customersQuery = customersQuery.is("whatsapp_phone", null);
  const { data: customers, count, error } = await customersQuery;
  if (error) throw new Error("N\u00e3o foi poss\u00edvel carregar os clientes.");
  if (page === 1) totalItems = count ?? 0;
  const totalPages = Math.ceil(totalItems / pageSize);
  const exportParams = new URLSearchParams();
  if (query) exportParams.set("q", query);
  if (contactFilter !== "all") exportParams.set("contact", contactFilter);
  const exportQuery = exportParams.toString();
  const exportHref = `/painel/${id}/clientes/export${exportQuery ? `?${exportQuery}` : ""}`;

  return <>
    <h1 className="mb-8 text-3xl font-semibold">Clientes</h1>
    <div className="grid items-start gap-8 lg:grid-cols-2">
      <section className="panel">
        <h2 className="mb-6 text-xl font-semibold">Cadastrar cliente</h2>
        <ActionForm action={saveCustomer.bind(null, id, null)} label="Cadastrar cliente">
          <label className="field">Nome<input name="name" required maxLength={120} autoComplete="name" /></label>
          <label className="field">E-mail (opcional)<input name="email" type="email" maxLength={254} autoComplete="email" /></label>
          <label className="field">WhatsApp (opcional)<input name="whatsapp_phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={32} placeholder="+55 11 99999-9999" /></label>
          <p className="text-sm text-stone-400">Use o código do país. O número fica privado e só é usado para abrir uma mensagem pronta para este cliente.</p>
        </ActionForm>
      </section>
      <section>
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold">Clientes cadastrados</h2><a className="button-secondary" href={exportHref}>Exportar CSV</a></div>
        <form key={`${query}:${contactFilter}`} method="get" className="mb-6 flex flex-wrap items-end gap-3">
          <label className="field min-w-56 flex-1">Buscar por nome, e-mail ou WhatsApp<input key={query} type="search" name="q" maxLength={120} defaultValue={query} /></label>
          <label className="field min-w-44">Contato<select key={contactFilter} name="contact" defaultValue={contactFilter}>
            <option value="all">Todos os contatos</option>
            <option value="missing-email">Sem e-mail</option>
            <option value="missing-whatsapp">Sem WhatsApp</option>
          </select></label>
          <button className="button" type="submit">Buscar</button>
          {(query || contactFilter !== "all") && <Link className="button-secondary" href={`/painel/${id}/clientes`}>Limpar</Link>}
        </form>
        {customers.length ? <><ul className="space-y-4">{customers.map(customer => {
          const galleryCount = customer.galleries?.[0]?.count ?? 0;
          const galleryCountLabel = galleryCount ? `${galleryCount} ${galleryCount === 1 ? "galeria vinculada" : "galerias vinculadas"}` : "Nenhuma galeria vinculada";
          return <li key={customer.id}>
          <details className="panel">
            <summary className="cursor-pointer break-words font-medium">
              <span className="flex items-start justify-between gap-3"><span>{customer.name}</span><span className="shrink-0 text-xs font-semibold text-stone-400">{galleryCountLabel}</span></span>
              <span className="mt-1 block text-sm font-normal text-stone-400">{customer.email ?? "Sem e-mail cadastrado"}</span>
              <span className="mt-1 block text-sm font-normal text-stone-400">{customer.whatsapp_phone ? `WhatsApp: ${customer.whatsapp_phone}` : "Sem WhatsApp cadastrado"}</span>
            </summary>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-stone-800 pt-4">
              <p className="m-0 text-sm text-stone-400">{galleryCountLabel}</p>
              {galleryCount > 0 && <Link className="text-sm text-amber-300 underline" href={`/painel/${id}?customer=${customer.id}`} aria-label={`Ver galerias de ${customer.name}`}>Ver trabalhos</Link>}
            </div>
            <div className="mt-6">
              <ActionForm action={saveCustomer.bind(null, id, customer.id)} label="Salvar cliente">
                <label className="field">Nome<input name="name" required maxLength={120} defaultValue={customer.name} /></label>
                <label className="field">E-mail (opcional)<input name="email" type="email" maxLength={254} defaultValue={customer.email ?? ""} /></label>
                <label className="field">WhatsApp (opcional)<input name="whatsapp_phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={32} placeholder="+55 11 99999-9999" defaultValue={customer.whatsapp_phone ?? ""} /></label>
                <p className="text-sm text-stone-400">Use o código do país. O número fica privado e só é usado para abrir uma mensagem pronta para este cliente.</p>
              </ActionForm>
              <DeleteCustomerForm action={deleteCustomer.bind(null, id, customer.id)} customerName={customer.name} />
            </div>
          </details>
        </li>;
        })}</ul><Pagination currentPage={page} totalPages={totalPages} totalItems={totalItems} firstItem={offset + 1} lastItem={offset + customers.length} hrefForPage={pageHref} label="Paginação de clientes" /></> : <p className="text-stone-400">{hasCustomerFilters ? "Nenhum cliente encontrado para os filtros atuais." : "Nenhum cliente cadastrado neste workspace."}</p>}
      </section>
    </div>
  </>;
}
