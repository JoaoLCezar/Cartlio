const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseUploadSessionPruneArguments(argv) {
  let mode = null;
  let tenantId = null;
  let retentionDays = 90;
  let retentionProvided = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if ((argument === "--local" || argument === "--remote") && mode === null) mode = argument;
    else if (argument === "--tenant" && tenantId === null && argv[index + 1]) tenantId = argv[++index];
    else if (argument === "--retention-days" && !retentionProvided && argv[index + 1]) {
      const value = argv[++index];
      if (!/^\d+$/.test(value)) throw new Error("A retenção de sessões deve ser um número inteiro de dias.");
      retentionDays = Number(value);
      retentionProvided = true;
    } else throw new Error("Uso: npm run uploads:prune -- --local|--remote [--tenant UUID] [--retention-days 90]");
  }

  if (!mode) throw new Error("Escolha explicitamente --local ou --remote.");
  if (tenantId && !uuidPattern.test(tenantId)) throw new Error("Workspace inválido.");
  if (!Number.isInteger(retentionDays) || retentionDays < 30 || retentionDays > 365) {
    throw new Error("A retenção de sessões deve estar entre 30 e 365 dias.");
  }
  return { mode, tenantId: tenantId?.toLowerCase() ?? null, retentionDays };
}
