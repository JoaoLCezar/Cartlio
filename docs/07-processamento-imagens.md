# Processamento privado de imagens

## Fluxo entregue

Os originais JPEG e PNG podem ter até 50 MiB. O processamento valida o tamanho antes de decodificar a imagem.

O worker grava o nome do workspace como marca d'água repetida nas miniaturas e previews compartilhados. Os arquivos originais usados em downloads permanecem sem alteração.

Após confirmar um upload, a foto entra em `pending`. O comando local `images:process` baixa o original privado, decodifica JPEG ou PNG com Sharp, limita a entrada a **40 milhões de pixels** e aplica **10 segundos por transformação**. Gera um preview WebP de até 1600 × 1600 pixels e uma miniatura WebP de até 400 × 400 pixels. Os derivados ficam nos buckets privados `gallery-previews` e `gallery-thumbnails`. O processamento remove metadados incorporados dos derivados por padrão.

Uma foto só passa a `ready` depois que ambos os derivados foram gravados e conferidos no catálogo do Storage. A galeria mostra a miniatura, abre o preview e oferece um link temporário separado para o original. Enquanto houver foto pendente ou em processamento, a galeria consulta o servidor automaticamente a cada cinco segundos e para quando todas estiverem prontas ou falharem. Enquanto a foto estiver pendente, em processamento, inválida ou com falha, não há URL de preview emitida pela aplicação. Acesso direto ao Storage dos derivados é restrito por RLS aos membros do workspace; [links controlados de galeria](08-compartilhamento-galerias.md) servem apenas derivados prontos por uma rota do servidor.

Um arquivo com assinatura JPEG/PNG mas conteúdo corrompido recebe `invalid`. Falhas temporárias voltam à fila após um minuto, até cinco tentativas. Uma tarefa interrompida pode ser retomada após uma concessão de 15 minutos. Um token por tentativa impede que uma execução antiga marque como pronta uma foto assumida por outra execução. Apenas a chave administrativa local pode reivindicar ou finalizar processamento. O navegador não recebe essa chave.

A exclusão de uma foto registra a intenção, remove miniatura, preview e original pelas APIs do Storage e só então apaga o registro. Se uma remoção falhar, **Exclusões pendentes** permite continuar. A função do banco se recusa a concluir a exclusão enquanto qualquer dos três objetos conhecidos existir.

## Operação local

Com Node.js, Docker e Supabase local disponíveis, aplique a migração e crie os buckets configurados:

```sh
npx supabase migration up --local
npm run db:seed
```

Ao iniciar o projeto com `npm run dev`, o servidor também inicia um worker local que consulta a fila a cada 10 segundos. As fotos são processadas automaticamente enquanto o servidor de desenvolvimento estiver aberto. O worker processa em lotes de até 100 tarefas e para junto com o servidor.

Para processar a fila manualmente, sem iniciar o servidor:

```sh
npm run images:process
```

Para processar apenas um workspace no Supabase local:

```sh
npm run images:process -- --tenant UUID_DO_WORKSPACE
```

Cada execução manual processa até 100 tarefas e exibe apenas totais: `examined`, `ready`, `invalid`, `retry` e `failed`. Uma falha temporária ou falha de confirmação faz o comando retornar código 1, preservando o estado para outra tentativa. O worker usa a chave administrativa obtida pelo CLI do Supabase local; não usa credenciais de produção. Fotos pendentes que já existiam também entram automaticamente na fila quando `npm run dev` é iniciado.

Em produção, não há execução automática, fila hospedada, painel operacional nem alertas. Para um piloto, isolar CPU e memória do processo, agendar execuções, configurar credenciais fora do app, monitorar idade das tarefas e falhas, e ensaiar retomada após interrupção. A limitação de tempo da biblioteca não substitui um limite externo de CPU/memória do processo. Não executar esse script com dados de produção sem essa infraestrutura.

O worker também pode rodar num runner separado do Supabase. Configure `SUPABASE_URL` e `SUPABASE_SERVER_SECRET_KEY` como segredos do ambiente, use HTTPS e execute `npm run images:process:remote`. Ele processa até 100 tarefas por execução e pode ser chamado novamente pelo agendador. A chave não deve ser colocada em argumento, log, arquivo versionado ou variável `NEXT_PUBLIC_*`. CPU e memória ainda precisam de limites no runner.

O runner `npm run maintenance -- --local` tenta novamente até 100 exclusões pendentes por execução. Remove miniatura, preview e original; o banco apaga os metadados apenas depois de confirmar que os objetos não existem. Se qualquer etapa falhar, a intenção permanece registrada. Para executar isoladamente, use `npm run photos:cleanup:deletions`; no runner remoto, use `npm run photos:cleanup:deletions:remote -- --tenant UUID`.

Para identificar objetos órfãos ou arquivos ausentes sem alterar o projeto local, execute `npm run storage:audit -- --local`. A auditoria percorre os quatro buckets e compara o inventário com fotos, sessões e logos. Ela não apaga nem repara objetos; veja [auditoria local do Storage](12-auditoria-storage.md).

## Limites conhecidos

A migração `20261108000100_watermarked_previews.sql` reenfileira os derivados antigos para que recebam a marca d'água. Durante o reprocessamento, essas fotos ficam temporariamente indisponíveis nos links compartilhados. Em ambientes com worker separado, pause o worker durante a migração e retome-o depois.

- Os derivados ainda não entram na cota técnica de bytes do workspace. A auditoria `storage:audit -- --local --usage` mede seu tamanho físico por workspace, mas transferência e cobrança do provedor ainda precisam ser medidas antes de definir planos comerciais.
- O worker não reconcilia derivados órfãos deixados por falha extrema ou concorrência com exclusão. A auditoria local ajuda a detectá-los, mas ainda é necessária uma rotina segura de reconciliação.
- Fotos em `failed` podem ser reenfileiradas pelo membro do workspace na galeria. Fotos marcadas `invalid` não podem ser reenfileiradas; envie uma cópia válida.
- Fotos antigas começam em `pending` após a migração. Executar o worker para gerar previews antes de considerar o ambiente atualizado.
- O arquivo original continua privado e disponível por URL temporária para membros via política existente do Storage. O compartilhamento com visitantes expõe apenas derivados prontos.

Referências: [limites de entrada do Sharp](https://sharp.pixelplumbing.com/api-constructor/), [metadados e decodificação](https://sharp.pixelplumbing.com/api-input/), [acesso a buckets privados do Supabase](https://supabase.com/docs/guides/storage/buckets/fundamentals).

Validação local: migrações aplicadas sem reset, 12 testes unitários, 157 verificações de banco e 2 cenários completos de navegador aprovados no Edge sobre build de produção. Lint e TypeScript passaram. O E2E confirma derivados WebP reais, isolamento entre workspaces, arquivo corrompido marcado como inválido e exclusão dos derivados. `npm audit --omit=dev` não apontou vulnerabilidades nas dependências de produção nesta execução. A CI remota e testes manuais em dispositivos reais ainda não foram observados.
