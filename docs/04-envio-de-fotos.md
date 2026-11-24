# Envio de fotos

## Armazenamento e acesso

Esta primeira versão usa o bucket privado `gallery-originals` do Supabase Storage para facilitar o uso local. O [blueprint original](01-etapa-a-blueprint.md) propõe Cloudflare R2. A troca por R2 ainda precisa de adapter, prova de custo e validação operacional antes de publicar o beta.

O objeto recebe o caminho `<workspace UUID>/<galeria UUID>/<foto UUID>.jpg|png`. A interface envia diretamente do navegador ao Storage, autenticada pela sessão Supabase; arquivo e metadados nunca passam pelo payload do Next Server Action.

A migração `20261023000100_gallery_photos.sql` cria `photos`, habilita RLS e aplica políticas ao bucket. A migração `20261123000100_resumable_large_photo_uploads.sql` eleva o limite para 50 MiB e habilita envio retomável para originais grandes. A galeria precisa pertencer ao workspace e o usuário precisa ser membro para enviar, ver ou limpar um upload incompleto. O bucket e o banco aceitam somente JPEG e PNG. O nome e o ID do objeto são gerados pelo app; o nome original serve apenas como metadado de apresentação.

O editor carrega os metadados das primeiras 60 fotos e busca as próximas páginas somente quando o fotógrafo pede mais. URLs assinadas duram 15 minutos e são criadas em lotes de até 100 caminhos, com no máximo quatro lotes simultâneos por bucket. Selecionar todas percorre apenas IDs em páginas de até 1.000; mover uma foto consulta somente o ID vizinho e salva a nova posição em uma operação transacional no banco. A exclusão em massa carrega os caminhos necessários em lotes de até 200 e valida todos antes de iniciar. A consulta de `photos` permanece restrita por RLS. Mesmo o status `published` não torna objetos ou galerias acessíveis anonimamente. O status archived impede envios novos; mantém as imagens anteriores disponíveis aos membros.

Antes de enviar, o navegador cria uma sessão no banco e reserva espaço do workspace. A confirmação verifica o objeto recebido e cria os metadados pela função `complete_photo_upload`. Se a conexão cair, a seção **Envios pendentes** permite confirmar, reenviar ou descartar o arquivo após recarregar. Veja [ciclo de upload e cotas](06-uploads-cotas.md) para os estados, limites e limpeza local de sessões vencidas.

## Exclusão recuperável de fotos

Membros do workspace podem excluir uma foto individual ou selecionar várias fotos na tela da galeria, após confirmação. A exclusão em lote executa as mesmas etapas de forma sequencial. Se uma falhar, o lote para: as fotos já concluídas permanecem excluídas, a foto interrompida fica em **Exclusões pendentes** e as demais continuam na galeria. A migração `20261025000100_recoverable_photo_deletion.sql` substitui a permissão de DELETE direto da etapa anterior por duas funções autenticadas e restritas à galeria:

1. `begin_photo_deletion` registra `deletion_requested_at` e devolve o caminho guardado no banco.
2. O navegador remove o arquivo pela API do Storage, com a sessão do membro.
3. `finish_photo_deletion` só remove os metadados se a intenção estiver registrada e o objeto não existir mais no catálogo do Storage.

A migração complementar `20261025000200_storage_deletion_intent.sql` exige a intenção também na política de DELETE do Storage para fotos registradas. Uma chamada direta à API por um membro não pode pular essa etapa.

Se a conexão cair, o registro permanece em **Exclusões pendentes**. O membro pode concluir a exclusão após recarregar a página; a rotina `npm run photos:cleanup:deletions -- --local` também retoma até 100 exclusões pendentes por execução e faz parte do runner `npm run maintenance -- --local`. Repetir o pedido é seguro, inclusive quando o arquivo ou os metadados já foram removidos. A interface não gera URLs para fotos pendentes; uma imagem ativa indisponível também não impede abrir as demais.

Galerias arquivadas continuam exibindo as fotos existentes e permitem excluí-las, mas não aceitam novos envios. Exclusões interrompidas podem ser retomadas por um membro ou pela rotina de manutenção. O agendamento e os alertas dessa rotina continuam pendentes para produção. Esta entrega também não reconcilia uploads órfãos anteriores. O processamento posterior gera arquivos derivados; a exclusão atual também remove miniatura e preview. O catálogo do Storage é somente consultado; arquivos são removidos pela API, conforme a [documentação do Supabase](https://supabase.com/docs/guides/storage/management/delete-objects).

## Limites desta etapa

- JPEG e PNG; até 50 MiB por imagem, 20 arquivos e 100 MiB por envio. Arquivos acima de 6 MiB usam TUS com retomada por partes.
- Uploads são sequenciais. Arquivos acima de 6 MiB usam TUS em partes de 6 MiB, com retomada no mesmo navegador quando o usuário seleciona novamente o mesmo arquivo e a sessão de envio ainda está válida. A galeria também permite confirmar um objeto que já chegou ao Storage, reenviar um arquivo ou descartar uma sessão pendente.
- Originais, miniaturas e previews privados. A entrega dos originais ocorre separadamente, conforme a permissão do link; os downloads individuais e em ZIP estão descritos em [downloads autorizados](10-downloads-autorizados.md). RAW não é aceito. Veja também [processamento de imagens](07-processamento-imagens.md).
- A verificação de cabeçalho no navegador é inicial; a decodificação e o limite de pixels são aplicados pelo worker local antes de mostrar previews. Imagens ainda não devem ser compartilhadas publicamente.

## Ativação local

`npm run db:start` agora inclui Storage e cria o bucket configurado. Como `supabase/config.toml` mudou, reinicie o stack local. `npx supabase stop` preserva os dados locais num volume Docker; não adicione `--no-backup`. Depois:

```sh
npm run db:start
npx supabase migration up --local
```

Confira `npx supabase status` e inicie o Next com `npm run dev`. Em um banco recriado, o `supabase start` já aplica as migrações; `migration up` também é seguro e indica que não há alterações pendentes.

No `compose.yaml`, mantenha `NEXT_PUBLIC_SUPABASE_URL=http://host.docker.internal:54321` para a aplicação no Docker e o navegador no Windows. A chave pública é a publishable/anon local; não configure a chave secret no navegador.

Em ambiente hospedado, `NEXT_PUBLIC_SUPABASE_STORAGE_URL` pode apontar para o hostname direto do Storage (`https://<project-ref>.storage.supabase.co`) para os uploads TUS. Se não estiver configurada, o app reutiliza `NEXT_PUBLIC_SUPABASE_URL`. O Supabase recomenda o hostname direto para melhorar o desempenho de transferências grandes ([documentação TUS](https://supabase.com/docs/guides/storage/uploads/resumable-uploads)).

## Testes automatizados e aceite manual

Testes automatizados:

```sh
npm test
npm run db:test
npx playwright install chromium
npm run test:e2e
```

O teste de navegador usa Edge no Windows; em Linux e CI usa o Chromium instalado pelo Playwright. Por padrão, ele executa o build de produção, inicia o Next em `127.0.0.1:3310` e encerra esse servidor ao terminar. Requer Supabase local iniciado e migrações aplicadas. O Next mantém os artefatos de desenvolvimento em `.next/dev`, separados do build de produção.

Para usar uma aplicação já iniciada, informe `PLAYWRIGHT_BASE_URL`. No PowerShell: `$env:PLAYWRIGHT_BASE_URL='http://localhost:3000'`. Nesse modo, a aplicação precisa apontar para o mesmo Supabase local usado pelo teste. Remova a variável com `Remove-Item Env:PLAYWRIGHT_BASE_URL` para voltar ao build automático.

O E2E cobre carregamento progressivo de fotos em páginas de 60, seleção de toda a galeria por IDs, cancelamento de exclusão, exclusão em lote, falha simulada no Storage, falha na confirmação após remoção do arquivo, retomada após reload e negação das funções de exclusão para outra conta. Cada execução cria dados próprios e os remove ao finalizar.

1. Crie um workspace e uma galeria como usuário A; envie uma foto JPEG e uma PNG e confirme que aparecem depois de recarregar.
2. Tente enviar WebP, SVG, nomear um PDF com extensão `.jpg`, enviar zero bytes ou selecionar um arquivo maior que 50 MiB; nenhum deve ser aceito.
3. Marque a galeria como publicada; confirme que ela continua fora do acesso anônimo.
4. Entre como B, tente abrir a galeria e pedir suas URLs assinadas; os metadados e objetos devem permanecer inacessíveis.
5. Exclua uma ou mais fotos e confirme que os arquivos e metadados desaparecem. Arquive a galeria; confirme que um novo envio é negado e as imagens restantes continuam visíveis aos membros.

## Validação da entrega anterior: exclusão recuperável

- Migrações de exclusão recuperável aplicadas no Supabase local sem reset.
- 12 testes unitários e 88 verificações de banco passaram.
- E2E passou no Edge sobre build de produção, incluindo falhas simuladas, retomada, registro antigo sem arquivo, proteção contra exclusão direta sem intenção ou por outra conta e ausência de rolagem horizontal no editor em 320 e 390 px.
- Build de produção e TypeScript passaram; lint sem erros ou avisos.
- A execução remota da CI e o aceite manual em dispositivos reais continuam pendentes; os tamanhos de tela móvel foram verificados por emulação no navegador.
