# Auditoria local do Storage

O comando `storage:audit` compara, em modo somente leitura, os objetos dos buckets privados `gallery-originals`, `gallery-previews`, `gallery-thumbnails` e `gallery-brand-assets` com as fotos, sessões de envio e logos de workspace registrados no banco. Ele também encontra logos referenciados cujo arquivo não está no Storage.

Com o Supabase local iniciado e as migrations aplicadas, execute:

```powershell
npm run storage:audit -- --local
```

Para limitar a auditoria a um workspace:

```powershell
npm run storage:audit -- --local --tenant UUID_DO_WORKSPACE
```

Para consultar bytes físicos por bucket e workspace e comparar originais/reservas com a cota configurada:

```powershell
npm run storage:audit -- --local --usage
```

Para guardar um snapshot local (o arquivo precisa ainda não existir):

```powershell
$reportDir = Join-Path $env:LOCALAPPDATA 'CartlioReports'
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$baseline = Join-Path $reportDir 'storage-baseline.json'
npm run storage:audit -- --local --usage --snapshot $baseline
```

Em uma execução posterior, compare com a mesma abrangência e, se aplicável, o mesmo workspace:

```powershell
npm run storage:audit -- --local --usage --compare $baseline
```

A saída inclui a variação em bytes por bucket, total e workspace, além do intervalo entre as medições. Deltas físicos ficam `null` se qualquer um dos relatórios estiver incompleto. Com `--r2`, o snapshot também inclui os bytes do bucket `r2-originals`; quando algum relatório contiver arquivos ou referências R2, os dois precisam incluir o inventário físico para calcular deltas completos. A cota contabilizada é comparada separadamente. Snapshots não são enviados ao banco e podem conter IDs de workspaces e, se combinado com `--details`, caminhos de objetos. Guarde-os em local apropriado. Para manter histórico, escolha um nome novo a cada medição.

Para incluir até 100 caminhos e IDs que precisam de investigação, acrescente `--details`:

```powershell
npm run storage:audit -- --local --details
```

Quando o bucket R2 de homologação estiver configurado, acrescente `--r2` para paginar o inventário físico dos originais e comparar chaves, tamanho e ETag com fotos; objetos associados a sessões de envio também têm o tamanho comparado com o declarado na sessão:

```powershell
npm run storage:audit -- --local --r2 --usage --details
```

Essa opção exige `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` e `R2_BUCKET` no processo local. Ela apenas lista os objetos; não envia, altera nem apaga arquivos. Sem `--r2`, referências R2 tornam a auditoria incompleta. Mantenha o R2 desativado até validar auditoria, backup e restauração com o bucket privado de homologação.

O relatório JSON traz totais de objetos e bytes por bucket, fotos e sessões verificadas, além de originais sem referência, derivados sem foto correspondente, originais ausentes e derivados ausentes em fotos prontas. `--usage` acrescenta bytes físicos estimados por workspace, compara o limite com fotos registradas e reservas ativas, e separa originais de previews/miniaturas. Os tamanhos vêm dos metadados listados pelo Storage; o relatório informa se algum objeto não trouxe tamanho. Por padrão, não inclui caminhos; `--details` inclui até 100 itens e informa se a lista foi truncada. O comando pagina as consultas e percorre subpastas dos buckets. Quando encontra inconsistências, retorna código de saída `1`; sem inconsistências, retorna `0`.

A auditoria não baixa o conteúdo dos objetos, altera registros, remove objetos nem tenta reparar inconsistências. Ela soma os tamanhos declarados nos metadados do Storage; isso não mede tráfego, processamento ou valores cobrados pelo provedor. Fotos com exclusão pendente são tratadas como em transição; sessões canceladas não mantêm um original referenciado. Objetos sem referência precisam ser investigados antes de qualquer limpeza, pois este relatório não decide se podem ser removidos.

O comando exige `--local` explicitamente e não usa credenciais remotas. Para projetos maiores, o tempo depende do número de objetos e registros percorridos.

## Prévia e limpeza conservadora de órfãos

O comando `storage:cleanup` permite tratar objetos antigos sem abrir uma limpeza global. Ele exige um UUID de workspace, considera apenas caminhos de objetos válidos e mantém a prévia como padrão. Um objeto só entra na lista se não estiver ligado a uma foto ou sessão ativa, tiver ao menos sete dias desde a criação e a última atualização e possuir ambas as datas válidas. Fotos em exclusão pendente e sessões em andamento continuam protegendo seus objetos.

Comece inspecionando a prévia:

```powershell
npm run storage:cleanup -- --local --tenant UUID_DO_WORKSPACE --details
```

O parâmetro `--older-than-hours` pode ajustar a janela, com mínimo de 24 horas e máximo de um ano. Para remover, execute uma segunda vez com `--apply` e repita o mesmo UUID em `--confirm-tenant`:

```powershell
npm run storage:cleanup -- --local --tenant UUID_DO_WORKSPACE --older-than-hours 168 --apply --confirm-tenant UUID_DO_WORKSPACE --details
```

Antes da remoção, o comando consulta de novo as referências no banco e o inventário do Storage; ele pula caminhos que passaram a ser referenciados, mudaram ou desapareceram. A operação é limitada ao workspace informado, remove em lotes e não pode ser desfeita. O desenvolvimento e os testes automatizados não executam `--apply` contra os dados locais.
