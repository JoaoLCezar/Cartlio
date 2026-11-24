export type CustomerCsvRow = {
  name: string;
  email: string | null;
  whatsapp_phone: string | null;
  created_at: string;
};

function csvCell(value: string): string {
  const safeValue = /^[\u0000-\u0020]*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safeValue.replaceAll('"', '""')}"`;
}

export function customerCsv(customers: CustomerCsvRow[]): string {
  const rows = [
    ["Nome", "E-mail", "WhatsApp", "Criado em"],
    ...customers.map(customer => [
      customer.name,
      customer.email ?? "",
      customer.whatsapp_phone ?? "",
      customer.created_at,
    ]),
  ];
  return `\uFEFF${rows.map(row => row.map(csvCell).join(";")).join("\r\n")}\r\n`;
}
