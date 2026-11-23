# Uploads recuperáveis e cota de armazenamento

## Comportamento entregue

Cada arquivo tem uma sessão persistida antes da transferência. Antes de começar, a interface mostra o espaço livre e verifica se cada arquivo do lote poderá obter sua reserva temporária de 50 MiB; o servidor continua sendo a autoridade se outra operação consumir a cota em paralelo. Durante o lote, a porcentagem acompanha o total dos arquivos e não volta ao início ao começar o próximo. A galeria permite confirmar, reenviar ou descartar um envio pendente, inclusive depois de fechar a página.

O painel do workspace apresenta a cota, os originais registrados, reservas ativas e o espaço disponível para novos envios. A mesma informação aparece junto ao envio de fotos na galeria; ambos os locais usam a função autenticada de cota, que verifica a associação ao workspace.

A migração `20261026000100_upload_reservations.sql` define um limite técnico inicial de **1 GiB por workspace**, alterável apenas pela administração. Isso ainda não é um plano comercial. Workspaces existentes com fotos acima desse limite recebem pelo menos o total já registrado; nenhum original é removido pela migração.

A migração `20261123000100_resumable_large_photo_uploads.sql` eleva o tamanho máximo e a reserva por sessão para **50 MiB**, e estende a expiração das novas reservas para quatro horas. O valor reservado independe do tamanho declarado pelo navegador: declarar um arquivo menor não permite ocupar mais espaço do que o reservado. Após a confirmação, apenas os bytes informados pelo Storage contam como uso. É preciso ter 50 MiB disponíveis para iniciar um arquivo, mesmo que ele seja menor.

## Estados e garantias

| Estado | Significado | Contagem de espaço |
| --- | --- | --- |
| `reserved` | Aguardando arquivo ou confirmação | 50 MiB reservados |
| `completed` | Foto registrada após conferir objeto, tamanho e MIME | Tamanho da foto em `photos` |
| `canceling` | Descarte iniciado, aguardando remoção e confirmação | 50 MiB reservados |
| `canceled` | Arquivo ausente e sessão encerrada | Nenhuma reserva |

`reserve_photo_upload` serializa as operações na linha do workspace. Repetir a mesma chave com os mesmos dados devolve a sessão, sem duplicar a reserva; dados diferentes são rejeitados. A chave encerrada não pode ser reutilizada.

`complete_photo_upload` só cria uma foto se a sessão estiver válida, a galeria aceitar envios e o objeto existir com tamanho e MIME correspondentes no catálogo do Storage. A criação da foto e a conclusão da sessão são atômicas. Repetir a confirmação não cria outra foto, nem recria uma foto posteriormente excluída. INSERT direto em `photos` deixa de ser permitido aos clientes.

A política de INSERT do Storage exige a sessão válida e bloqueia a linha da sessão durante a inserção no catálogo. O descarte usa essa mesma linha para serializar a transição: depois de liberar uma reserva, um upload atrasado não pode registrar um novo objeto nela. O navegador não pode sobrescrever arquivos existentes.

`begin_upload_cancellation` registra a intenção de descarte. A aplicação remove o arquivo pela API do Storage; `finish_upload_cancellation` libera a reserva somente depois de confirmar sua ausência. Falhas deixam a pendência disponível para outra tentativa. Galerias arquivadas permitem descarte, mas recusam novos uploads e confirmações.

Fotos com exclusão pendente continuam ocupando espaço até `finish_photo_deletion` remover seus metadados. Consultas e funções verificam o workspace do usuário. O browser recebe apenas a chave pública e a sessão autenticada.

## Expiração e limpeza local

Novas reservas tentam encerrar sessões vencidas do workspace: as vazias são canceladas; aquelas com objeto ficam em `canceling`. Essa atualização faz parte da transação da reserva e só persiste quando a chamada termina com sucesso. Uma sessão vencida com arquivo continua reservando espaço até a limpeza confirmada.

Com o Supabase local iniciado e as migrações aplicadas:

```sh
npx supabase migration up --local
npm run uploads:reconcile
```

Para limitar a manutenção a um workspace:

```sh
npm run uploads:reconcile -- --tenant UUID_DO_WORKSPACE
```

O comando consulta até 100 sessões vencidas ou em descarte por execução, usa as funções de cancelamento e remove arquivos pela API. Exibe apenas os totais `examined`, `cleaned` e `failed`; retorna código 1 se houver falha. Pode ser repetido. O modo local obtém a chave administrativa pelo CLI e não a envia ao Next ou ao navegador. O comando não precisa de um usuário conectado.

Para um runner externo, configure `SUPABASE_URL` e `SUPABASE_SERVER_SECRET_KEY` como segredos do ambiente e execute `npm run uploads:reconcile:remote`. O modo remoto exige HTTPS, não chama o CLI local e nunca carrega segredos no app ou navegador. Não há agendamento instalado. Antes de produção, configurar a periodicidade, métricas de idade das pendências, alertas, tentativas com espaçamento e tratamento de falhas persistentes. Um lote com 100 falhas antigas pode impedir o avanço para registros mais recentes; a ferramenta requer intervenção nesse caso.

Sessões concluídas e canceladas são mantidas por 90 dias para dar uma janela de idempotência às tentativas repetidas. `npm run uploads:prune` remove tombstones mais antigos em lotes de até 500 sessões; sessões reservadas, em cancelamento ou ainda ligadas a um objeto sem foto correspondente ficam protegidas. Para limitar por workspace, acrescente `-- --tenant UUID`; o comando remoto aceita `npm run uploads:prune:remote -- --tenant UUID`. `npm run maintenance` executa a reconciliação primeiro e a retenção depois. A rotina de produção precisa ser agendada junto do runner.

## Limites conhecidos

Para revisar o uso físico antes de definir limites comerciais, execute `npm run storage:audit -- --local --usage`. O relatório soma metadados de originais, previews e miniaturas e mostra separadamente os bytes considerados pela cota de upload. Não mede transferência nem custos do provedor.

- Arquivos até 6 MiB usam o envio padrão. Arquivos maiores usam TUS em partes de 6 MiB; a URL de retomada fica no armazenamento local do navegador. Para continuar após reload ou queda de rede, selecione novamente o mesmo arquivo no mesmo navegador. Sessões novas e reservas expiram em quatro horas.
- Tamanho e MIME são conferidos contra os metadados do Storage na conclusão do upload. A decodificação e geração de derivados acontecem depois, na [etapa de processamento](07-processamento-imagens.md). Uma foto concluída ainda pode ser classificada como inválida.
- A reconciliação de uploads não corrige órfãos antigos do Storage nem divergências físicas do provedor. `storage:audit` identifica inconsistências sem alterar dados; `storage:cleanup` oferece prévia e limpeza local de órfãos antigos. Exclusões pendentes de fotos usam a rotina própria de retomada.
- A chave de idempotência fica protegida enquanto o tombstone existe; depois da retenção, uma chave antiga cancelada pode voltar a ser reservada. O cliente gera UUIDs aleatórios e a janela padrão é de 90 dias, configurável entre 30 e 365.
- A cota técnica contabiliza originais registrados e reservas ativas. A auditoria `storage:audit -- --local --usage` mede separadamente os bytes físicos de originais, previews e miniaturas; ela não mede transferência nem valores cobrados pelo provedor.
- Aplicar migração e frontend juntos. Clientes com a versão anterior aberta devem recarregar a página. Não usar reset para atualizar dados existentes.

## Testes

```sh
npm test
npm run db:test
npm run test:e2e
npm run lint
npm run typecheck
```

O E2E faz o build de produção e inicia o servidor automaticamente; exige o Supabase local. A cobertura nova verifica interrupção antes e depois da transferência, recuperação após reload, repetição idempotente, disputa simultânea pelo último espaço, isolamento entre contas, tamanho/MIME incompatíveis, descarte e expiração. A limpeza local é executada contra sessões criadas pelo teste e precisa preservar sessões ativas e fotos concluídas.

Validação local da etapa anterior: migração aplicada sem reset; 12 testes unitários, 137 verificações de banco e 2 cenários E2E aprovados no Edge sobre build de produção. TypeScript aprovado e lint sem erros ou avisos. A execução remota da CI e testes manuais em dispositivos reais continuam pendentes.

Validação do upload retomável: migração aplicada sem reset, buckets locais atualizados, 66 testes unitários e 367 verificações de banco aprovados. O E2E no Edge confirma o envio de um PNG acima de 6 MiB pelo endpoint TUS e verifica que os bytes armazenados correspondem ao original. O envio padrão para arquivos menores também continua coberto.

Validação da retenção de sessões: migration aplicada incrementalmente no Supabase local, sem reset. A suíte de banco confirma retenção limitada e escopada por workspace, preservação de reservas e cancelamentos em andamento, e proteção para objetos sem foto correspondente.

Continuação entregue: [processamento de imagens e geração de miniaturas/previews](07-processamento-imagens.md). O compartilhamento com clientes segue pendente.
