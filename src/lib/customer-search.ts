export type CustomerContactFilter = "all" | "missing-email" | "missing-whatsapp";

export function parseCustomerContactFilter(value: string | null | undefined): CustomerContactFilter {
  return value === "missing-email" || value === "missing-whatsapp" ? value : "all";
}

export function customerSearchFilter(query: string): string | null {
  const term = query.trim();
  if (!term) return null;

  const likeValue = term.replace(/[\\%_]/g, "\\$&");
  const postgrestValue = likeValue.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const pattern = `"%${postgrestValue}%"`;
  const phoneDigits = /^[+()\d\s.-]+$/.test(term) ? term.replace(/\D/g, "") : "";
  const phoneFilter = phoneDigits.length >= 2 ? `,whatsapp_phone.ilike."%${phoneDigits}%"` : "";
  return `name.ilike.${pattern},email.ilike.${pattern}${phoneFilter}`;
}
