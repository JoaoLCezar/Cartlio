# Adaptação do Quadrics

Este roteiro compara as fases 1 e 2 do Documento Mestre do Quadrics com o código existente. O estado atual foi identificado por leitura do repositório. A aceitação do piloto depende de validação no ambiente de homologação.

Para a ordem de execução, as dependências e os critérios de conclusão, consulte o [plano de ação do Quadrics](superpowers/plans/2026-11-22-quadrics-plano-de-acao.md).

As configurações novas usam o prefixo `QUADRICS_`. O prefixo legado `CARTLIO_` continua aceito, com prioridade para a configuração nova quando ambas existirem. O identificador do Supabase local, os cookies de PIN, as referências de retomada de upload, os identificadores de mensagens e de saúde em `/api/health` e o formato dos backups continuam compatíveis com instalações anteriores. As migrações já publicadas mantêm seu conteúdo histórico.

## O que reaproveitar e o que adaptar

| Área | Base existente | Entrega para o Quadrics |
| --- | --- | --- |
| Cadastro e isolamento | Supabase Auth, perfis, workspaces, membros e políticas de acesso no PostgreSQL (RLS). | Reaproveitar o workspace como ambiente do fotógrafo ou estúdio. Manter as migrações SQL e as políticas atuais. |
| Site e identidade | Página inicial, cadastro, login e marca própria do estúdio nas galerias. | Aplicar Quadrics como marca do produto no site, autenticação, painel, galerias, cartões de compartilhamento e notificações. Preservar a marca de cada estúdio e os contratos de configuração existentes. |
| Fluxo de galerias | Clientes, galerias, envio de fotos, processamento de imagens, compartilhamento por link, PIN, seleção e download individual ou ZIP conforme permissões. | Reaproveitar o fluxo. Validar a experiência em celular e a separação entre seleções e entregas no piloto. |
| Perfil público | Portfólio básico em `/fotografo/<slug>`, com rascunho, publicação e seleção de fotos. | Aplicar a migração e validar a publicação, a retirada de fotos, a despublicação e a experiência em celulares. |
| Armazenamento | Buckets privados no Supabase Storage, upload direto e retomada via TUS, cotas e rotinas de limpeza. | Integrar R2 e preservar as regras de acesso, validação, confirmação, cotas e recuperação. |
| Operação | Dockerfile para a aplicação web, Compose de desenvolvimento, rotinas de manutenção, backup e prontidão. | Preparar a homologação na Azure com HTTPS, processos de imagem e manutenção, monitoramento e verificação de restauração. |

## Ordem proposta de entrega

1. **Marca pública.** O código agora apresenta Quadrics nas páginas, nos títulos, nos cartões e nas notificações. A atualização de um ambiente deve incluir a migração `20261216000100_quadrics_gallery_brand.sql` e o nome de exibição em `QUADRICS_SMTP_FROM`, se configurado. Conferir o site, o acesso ao painel e uma galeria com e sem marca própria de estúdio.
2. **Perfil do fotógrafo.** O proprietário pode salvar um rascunho em **Painel → Portfólio** e publicar em `/fotografo/<slug>`. O perfil aceita nome, apresentação, e-mail público e até 12 fotos processadas. A primeira foto é a capa. A página pública recebe apenas os campos publicados e os identificadores das fotos selecionadas. A rota de imagem verifica novamente a seleção e serve o WebP otimizado. A migração `20261217000100_public_portfolios.sql` precisa ser aplicada antes de disponibilizar a tela.
3. **R2.** Manter PostgreSQL e Supabase Auth. Isolar o acesso a objetos e integrar upload direto com confirmação no servidor, downloads autorizados, processamento de imagens e limpeza. Definir e validar a retomada de uploads grandes, já que o cliente atual usa TUS. Conferir ZIPs, cotas, exclusão e restauração. Se houver fotos a preservar, inventariar e verificar as cópias antes de mudar as referências usadas pela aplicação.
4. **Homologação na Azure.** Resolver o acesso SSH. Preparar o serviço web, o processo de imagens e a manutenção agendada. Configurar proxy com HTTPS, URL pública, autenticação e segredos do ambiente. Confirmar saúde da aplicação e das filas, capacidade de restauração e comportamento com imagens nas condições do piloto. A preparação da homologação pode começar em paralelo com as etapas anteriores.

## Próxima entrega de armazenamento

As leituras da aplicação passam por `src/lib/media-storage.ts`. Galerias, portfólio, marca de estúdio, URLs assinadas, downloads individuais e ZIP deixam para essa camada a escolha dos buckets e o acesso aos bytes. O painel usa a sessão do membro. Nos links externos, o banco autoriza o objeto antes da leitura. O Supabase continua atendendo todas as leituras; ainda não há escrita ou leitura em R2.

O envio agora passa por `src/lib/photo-upload-flow.ts`. Ele valida o arquivo, pede a reserva de espaço e coordena confirmação, retomada e descarte. A transferência direta e a retomada TUS ficam em `src/lib/supabase/photo-upload-transport.ts`. O transporte continua usando o mesmo identificador local de retomada, e o banco continua controlando cotas e estados da sessão.

A migração `20261218000100_photo_storage_provider.sql` adiciona `storage_provider` a sessões e fotos. Os registros existentes passam a indicar Supabase sem alteração de chaves, estados ou arquivos. A confirmação copia o provedor da sessão para a foto. O banco aceita apenas Supabase nesta etapa, e a rotina de reconciliação do Supabase consulta apenas sessões desse provedor. Aplique a migração antes de publicar o código que lê o novo campo.

A migração `20261219000100_finalize_verified_photo_upload.sql` separa a consulta ao armazenamento da finalização do envio. O RPC atual continua validando acesso, estado da sessão e existência do objeto no Supabase. A rotina privada compara a chave, o provedor, o tamanho e o tipo com a reserva antes de registrar a foto e concluir a sessão na mesma operação. Ela não aceita chamadas diretas da aplicação.

O leitor `scripts/lib/r2-object-metadata.mjs` prepara a consulta autenticada ao R2. Recebe uma reserva já autorizada pelo banco, confere a chave do estúdio, galeria e envio, e usa `HeadObject` para obter o tamanho e o tipo informado pelo armazenamento, sem baixar o arquivo. Ausência, falha de acesso e divergência são tratadas separadamente. Os testes simulam a resposta do armazenamento. [API S3 do R2](https://developers.cloudflare.com/r2/api/s3/api/) · [Operação HeadObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html).

O módulo `scripts/lib/confirm-r2-photo-upload.mjs` liga a leitura dos metadados à finalização no banco. Ele resolve a reserva com a sessão do usuário antes de consultar o objeto. A migração `20261220000100_confirm_r2_photo_upload.sql` adiciona uma confirmação restrita à credencial de servidor, que verifica novamente o estúdio, registra a foto e grava o ETag verificado. Repetir a confirmação com outro ETag não substitui a foto. A aplicação web ainda não expõe esse fluxo e as restrições do banco continuam aceitando somente Supabase.

O módulo `scripts/lib/r2-originals.mjs` emite URLs de PUT para a chave da reserva, válidas por até 60 segundos e nunca além da reserva. A assinatura exige `If-None-Match: *`, o tipo e o tamanho reservado. O caminho de processamento de um original R2 usa `If-Match` com o ETag gravado e confere os metadados e a quantidade recebida antes de decodificar a foto. Essa leitura fica inativa enquanto o banco aceitar apenas Supabase. [Operações condicionais no R2](https://developers.cloudflare.com/r2/api/s3/conditional-operations/) · [URLs assinadas](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

A migração `20261221000100_download_original_storage_identity.sql` inclui provedor, tamanho e ETag na autorização de downloads. O individual e o ZIP usam essa referência para abrir originais do R2 com `If-Match` e transmitir os bytes em fluxo. O ZIP pode combinar provedores e mantém a reconciliação das entradas interrompidas. Downloads do Supabase seguem usando o caminho anterior. As reservas R2 continuam desativadas.

A migração `20261222000100_hold_r2_upload_reservations.sql` registra a autorização antes de o servidor assinar uma URL de PUT. Ao expirar a sessão, o reconciliador libera a reserva sem autorização emitida. Se houve autorização e o envio ficou inconclusivo, conserva a cota em `canceling`, inclui a pendência no relatório e preserva o estado para investigação. Uma resposta 404 ou a expiração da URL, isoladamente, não provam que uma transferência já iniciada terminou. [Consistência e gravações em andamento no R2](https://developers.cloudflare.com/r2/reference/consistency/).

O módulo `scripts/lib/r2-multipart-upload.mjs` prepara o fluxo por partes: inicia a transferência com o identificador da reserva nos metadados do objeto, assina cada parte pelo tamanho esperado e conclui usando somente partes e ETags listados pelo provedor. A conclusão exige criação condicional. O descarte só reconhece o encerramento do identificador de upload após `ListParts` retornar explicitamente `NoSuchUpload`. Esse resultado indica que a transferência fechou, mas ainda pode existir um objeto final se uma conclusão ganhou a corrida. [Operações condicionais no R2](https://developers.cloudflare.com/r2/api/s3/conditional-operations/).

Antes de ativar R2, falta registrar a intenção e o identificador de upload de forma durável no banco, serializar iniciação e descarte, e verificar o objeto final antes de apagar ou devolver a cota. O PUT direto permanece fora do fluxo ativo enquanto não houver uma forma segura de encerrar autorizações inconclusivas. Também falta validar CORS no navegador e aplicar a verificação por provedor ao download de originais no painel. [CORS para URLs assinadas](https://developers.cloudflare.com/r2/buckets/cors/).

Depois, conectar o processamento, downloads autorizados e ZIP, limpeza, auditoria e backup ao registro do provedor. Manter a leitura de objetos legados durante a transição. A troca só fica completa após validar upload, retomada, original, WebP, exclusão e restauração e verificar os objetos já existentes.

Adicionar Prisma agora exigiria rever consultas e autorização sem entregar uma capacidade nova ao MVP. A recomendação é conservar o acesso atual ao PostgreSQL pelo Supabase e manter as migrações versionadas. Subdomínios por fotógrafo e domínios próprios podem vir depois do perfil publicado por caminho. Planos, assinaturas, pagamentos, painel administrativo global e venda de fotos ficam para a etapa comercial ou posterior. As cotas técnicas existentes continuam úteis durante o piloto.

## Aceitação do MVP

Um fotógrafo deve conseguir se cadastrar, publicar o perfil, criar uma galeria, enviar fotos e compartilhar um link. Um cliente sem conta deve conseguir visualizar a galeria no celular, enviar a seleção quando solicitada e baixar os arquivos autorizados quando disponibilizados. Validar também o isolamento com um segundo workspace e a operação do fluxo na homologação, com os originais guardados no armazenamento de objetos.
