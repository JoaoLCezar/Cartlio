# Caminho para um piloto e uma futura operação comercial

Este documento transforma o blueprint em uma sequência de entregas verificáveis. A direção é completar o ciclo de trabalho de um fotógrafo: criar a galeria, enviar fotos, compartilhar previews, receber a seleção e entregar os arquivos autorizados. Preço, planos, retenção e volume do piloto continuam sendo decisões de produto a validar.

## Base atual

Galerias recorrentes podem servir de modelo para outro trabalho. A cópia mantém título e descrição, cria endereço exclusivo e começa como rascunho, sem cliente, capa, fotos, links ou histórico do original.

- Conta, perfil, workspaces e gestão de clientes (criar, editar e excluir somente quando sem galerias) com isolamento por RLS.
- Gestão de equipe: o proprietário lista membros e papéis, remove colaboradores com revogação imediata do acesso, transfere a propriedade para um colaborador existente e emite/revoga convites de uso único, válidos por sete dias e vinculados a e-mail confirmado. O antigo proprietário passa a `editor`; os links são compartilhados manualmente. As últimas 50 entradas de membros, convites e transferências ficam visíveis no histórico privado da equipe.
- Originais privados JPEG/PNG no Supabase Storage, com limites por arquivo e envio.
- Capas do painel resolvidas no banco para no máximo uma foto por galeria e URLs de miniaturas assinadas em lote, sem carregar todos os metadados de fotos prontas nem fazer uma chamada ao Storage por cartão.
- Ordem das fotos organizada pelo fotógrafo e preservada na galeria pública.
- Exclusão com intenção persistida, confirmação da ausência do objeto e retomada após falha.
- Sessões de upload recuperáveis, reserva de espaço, cota por workspace, reconciliação com runner remoto e resumo operacional por workspace/galeria.
- Retenção de 90 dias para sessões de upload concluídas ou canceladas, em lotes limitados e preservando sessões em transição ou objetos sem foto correspondente.
- Worker de imagens com decodificação e geração de miniaturas/previews, executável localmente ou num runner remoto.
- Links de galeria com token em hash, expiração e revogação. O fotógrafo pode renovar um token perdido sem descartar a seleção ou seu histórico; o token anterior é invalidado e sessões PIN são revogadas.
- Identidade pública por workspace, com nome, cor e logo definidos pelo proprietário; a página da marca mostra uma prévia responsiva atualizada em tempo real; o nome interno não aparece sem configuração explícita. O logo fica em bucket privado e só é servido depois da autorização do link compartilhado.
- O painel acompanha a primeira entrega com etapas de criação da galeria, envio de fotos e compartilhamento; o guia continua disponível até existir um link ativo e respeita os filtros e a paginação da lista.
- Seleção de fotos persistida por link, limite configurável de escolhas, envio confirmado e consulta pelo fotógrafo; pedidos de ajuste preservam a versão anterior e suspendem os downloads até a nova liberação. Uma fila transacional avisa o fotógrafo sobre seleções enviadas e o cliente sobre ajustes, quando há e-mail cadastrado. O painel também prepara uma mensagem de WhatsApp, sem expor PIN nem token do link.
- Downloads originais separados da visualização, limitados à seleção enviada e auditados por link.
- Endpoints separados de liveness e readiness; readiness verifica banco, credenciais e buckets privados.
- Comando `npm run health:check` para probe de readiness em CI ou agendador, com timeout e código de saída próprio.
- Runner de manutenção sequencial que reconcilia uploads, retoma exclusões, processa imagens, entrega notificações por e-mail e remove eventos de download vencidos.
- Backup local de roles, schema, Auth e dados `public`, migrations e objetos dos quatro buckets com manifesto SHA-256; ensaio automatizado de restauração em Supabase descartável implementado.
- Cabeçalhos globais contra MIME sniffing, enquadramento da aplicação e permissões desnecessárias do navegador.
- Testes unitários, regras de acesso no banco e fluxo real de navegador com falhas simuladas.

Publicar uma galeria permite criar links temporários para previews e seleção. O fotógrafo pode liberar downloads dos originais escolhidos após o envio; cada link é curto, limitado e registrado. Os testes locais não equivalem a um piloto em produção.

## Sequência de entregas

| Ordem | Resultado para o produto | Critério de aceite |
| --- | --- | --- |
| 1 — base local entregue | Fotos consistentes mesmo com interrupções | Exclusão e upload recuperáveis, reserva de espaço, prazo, reconciliação de sessões vencidas e indicadores de pendências por galeria. A retenção das sessões encerradas e a prévia de limpeza conservadora de órfãos estão implementadas. Antes do piloto: agendar o runner e validar recuperação e limpeza no ambiente isolado de produção. |
| 2 — base local entregue | Galerias rápidas e imagens preparadas para clientes | Worker executável em modo local ou remoto, decodifica imagens, aplica limites de pixels/tempo e gera miniaturas e previews privados. O painel mostra tarefas pendentes, em processamento e com falha, além das seleções recebidas que aguardam conferência. Antes do piloto: agendar execução e isolar o processo no ambiente de produção. |
| 3 — base local entregue | Compartilhamento de uma galeria com acesso controlado | Link portador restrito à galeria, token armazenado como hash, expiração e revogação; cada imagem é autorizada no servidor, só previews prontos aparecem e seguem a ordem escolhida pelo fotógrafo. PIN, imagens e gravações de seleção têm limites no banco. Antes do piloto: controles no proxy, observabilidade e ajuste dos limiares. |
| 4 — base local entregue | Cliente escolhe as fotos e fotógrafo recebe a seleção | Escolhas persistem por link, respeitam o limite definido pelo fotógrafo e são enviadas com confirmação. O fotógrafo recebe aviso por e-mail e encontra as até 10 seleções mais antigas ainda não conferidas no painel, com atalho direto para a galeria e opção de reabri-las como pendência; novos envios voltam à fila. Pedidos de revisão são enfileirados para o e-mail do cliente vinculado. Após o envio, o cliente só pode alterar a seleção se o fotógrafo solicitar ajustes; a versão anterior fica no histórico e os downloads param até a nova liberação. Os fluxos públicos, painel e editor da galeria têm verificações E2E sem rolagem horizontal em 320–390 px; validação manual em celulares reais ainda pendente. |
| 5 — base local entregue | Entrega de arquivos autorizados | Permissão separada por link, URLs de 60 segundos, até 3 emissões por foto e histórico visível ao fotógrafo. Eventos são limpos após 90 dias por padrão; revisar o prazo, agendar a rotina em produção, proteger contra compartilhamento do link e validar custos de transferência antes do piloto. |
| 6 — base local parcial | Piloto acompanhado | Recuperação de conta validada no Supabase local, cabeçalhos globais e probe de readiness cobertos por E2E. O ensaio de restauração agora valida login no navegador de um membro já restaurado e acesso ao workspace. Na CI, uma conta sintética confirma também que a senha original do backup continua válida; em backups manuais sem credencial conhecida, o E2E troca a senha apenas na cópia descartável. Credenciais de usuários reais de um backup de produção e a restauração hospedada ainda exigem validação no ambiente correspondente. Antes de um piloto: separar teste e produção, conectar alertas à prontidão, definir retenção e documentar o atendimento e a recuperação. |
| 7 | Preparação para cobrar | Piloto mede uso, suporte e custos; planos e limites definidos a partir desses dados. Cobrança com eventos idempotentes e reconciliação antes de aceitar pagamentos reais. |

Cada etapa deve entregar código, migração quando necessária, testes de sucesso e falha, instruções de operação e limites conhecidos. Uma nova funcionalidade não deve depender de tratar um erro como sucesso.

## Ciclo atual e próximo incremento

O upload agora reserva espaço antes de transferir bytes e confirma tamanho e tipo informados pelo Storage antes de registrar a foto. A sessão persiste após uma interrupção. A cota é aplicada no servidor, com serialização de reservas concorrentes. Os detalhes e limites operacionais estão em [uploads e cotas](06-uploads-cotas.md).

O processamento de imagens, reconciliação de uploads, entrega de notificações e limpeza do histórico agora podem usar credenciais injetadas num runner remoto; o painel resume envios e estados de processamento por workspace e galeria, e lista até 10 seleções ainda não conferidas, da mais antiga à mais nova, com acesso direto para conferência. Veja [processamento](07-processamento-imagens.md), [seleção](09-selecao-fotos.md), [uploads](06-uploads-cotas.md) e [downloads](10-downloads-autorizados.md). A periodicidade, alertas e isolamento de recursos ainda precisam ser configurados no ambiente de produção. Imagens compartilhadas têm limite por link e endereço do cliente; gravações de seleção têm teto de 300 por minuto e por link aplicado no banco. Observar e ajustar os limiares continua pendente no piloto. A escolha entre manter Supabase Storage e adotar R2 precisa acompanhar medições de operação; não há migração de provedor aprovada neste documento.

`/api/health` confirma que o processo web responde. `/api/ready` também verifica a função de banco usada pelas galerias, a disponibilidade dos quatro buckets privados e a configuração do cabeçalho de IP confiável. Use a prontidão nos checks de deploy; ligar alertas e definir limites de indisponibilidade continua sendo tarefa de implantação.

`npm run health:check` consulta `/api/ready` local em `127.0.0.1:3000`. Para outro ambiente, configure `READINESS_URL` ou passe `npm run health:check -- --url https://app.exemplo.com/api/ready`; URLs remotas exigem HTTPS e não aceitam credenciais nem query string. O comando termina com código 1 se o endpoint não retornar estado pronto, e pode ser usado em CI ou no agendador do host. Ele não envia alertas por si só.

`npm run maintenance -- --local --dry-run` mostra a ordem das tarefas sem acessar o banco. `npm run maintenance -- --local` reconcilia uploads, limpa tombstones antigos de upload em lotes, retoma até 100 exclusões de fotos, processa até 100 imagens, entrega notificações SMTP e remove eventos de download com retenção de 90 dias, nessa ordem. Durante `npm run dev`, workers locais de imagens e notificações rodam continuamente e exibem uma linha de diagnóstico sanitizada quando uma execução falha antes de tentar novamente. As tarefas são independentes: uma falha não impede as seguintes, mas deixa código de saída 1 e um resumo por tarefa com diagnóstico curto e limitado quando disponível. `--tenant UUID` limita reconciliação, retenção de sessões, exclusões e processamento ao workspace; `--retention-days 30..365` altera a retenção dos eventos de download. Para produção, use `--remote` num runner com `SUPABASE_URL`, `SUPABASE_SERVER_SECRET_KEY` e `QUADRICS_SMTP_*`, agende a frequência adequada e monitore o código de saída. O comando não agenda execuções remotas sozinho.

`npm run storage:audit -- --local` compara fotos, sessões, logos e objetos nos quatro buckets em modo somente leitura; `--tenant UUID` limita a consulta a um workspace. O relatório retorna totais sem expor caminhos. Código de saída 1 indica inconsistências que precisam de investigação. A auditoria não remove nem repara objetos; consulte [auditoria local do Storage](12-auditoria-storage.md).

`npm run storage:cleanup -- --local --tenant UUID --details` calcula uma prévia de órfãos antigos. A remoção requer uma execução separada com `--apply` e repetição explícita do UUID em `--confirm-tenant`; antes disso, referências e inventário são verificados novamente. A limpeza é restrita a um workspace e a caminhos de objetos do Quadrics reconhecidos; consulte [auditoria local do Storage](12-auditoria-storage.md).

Os cabeçalhos globais protegem contra MIME sniffing e framing, removem referrer, desativam permissões de câmera, microfone e geolocalização e ativam HSTS em produção. As páginas do app recebem CSP com nonce por requisição, incluindo as origens Supabase configuradas. Antes de publicar, ainda é preciso validar a política no domínio final e configurar TLS, proxy confiável, limites de requisição, alertas e a operação dos workers; consulte [infraestrutura, confiabilidade e segurança](13-infraestrutura-seguranca.md).

## O que medir no piloto

O comando local `npm run storage:audit -- --local --usage` mede bytes declarados pelo Storage por bucket e workspace, e compara fotos/reservas com a cota técnica. `--snapshot FILE` salva uma medição local sem sobrescrever arquivos; `--compare FILE` calcula a variação desde um snapshot compatível. Isso dá uma base para observar o peso dos derivados; transferência, processamento e preço do provedor continuam precisando de medição no piloto.

| Pergunta | Evidência a coletar |
| --- | --- |
| O fotógrafo consegue começar sozinho? | Tempo até criar e enviar a primeira galeria; etapas que exigem ajuda. |
| O fluxo de entrega resolve o trabalho? | Galerias compartilhadas, seleções enviadas e downloads concluídos. |
| O produto é confiável? | Taxa de upload concluído, idade das pendências, falhas de processamento e tempo de recuperação. |
| O serviço tem custo sustentável? | Bytes por workspace, processamento, transferência, operações de armazenamento e tempo de suporte. |
| Existe interesse em continuar usando? | Uso recorrente em trabalhos reais e feedback após a entrega ao cliente. |

O tamanho do piloto e as metas numéricas serão definidos com os primeiros fotógrafos. Não há projeção de receita nem preço validado. A comercialização depende de demonstrar o fluxo completo, conhecer o custo de atender e ter capacidade de recuperar falhas com os dados dos clientes protegidos.

## Limites da entrega de confiabilidade

A rota pública de imagens aplica até 1.800 solicitações por minuto para cada link e origem, com estado HMAC removido após 24 horas de inatividade. A tarefa `gallery-rate-limits` do runner de manutenção remove até 1.000 registros vencidos por execução.

As gravações de seleção (escolha, observação, limpeza e envio) são limitadas a 300 por minuto por link diretamente no banco, inclusive em chamadas RPC. O estado por link sem atividade é removido pela mesma tarefa de limpeza. Esse teto compartilhado não identifica cada visitante e complementa a proteção por IP que ainda precisa ser configurada no proxy.

O runner de manutenção retoma exclusões de fotos pendentes, até 100 por execução, antes de processar novas imagens. Agendamento e alertas continuam pendentes. A auditoria local do Storage detecta inconsistências sem alterar dados; `storage:cleanup` oferece prévia local e remoção manual, limitada a um workspace, objetos antigos sem referência e caminhos de objetos do Quadrics reconhecidos. Uma rotina remota ou agendada de limpeza de órfãos ainda requer operação e validação próprias.

As funções verificam identidade, workspace e galeria em toda chamada, mesmo executando com privilégios elevados. O frontend não recebe chave administrativa. Os metadados permanecem disponíveis somente aos membros durante a pendência. Uploads, retenção de sessões, exclusões de fotos, processamento e limpeza do histórico têm comandos que aceitam credenciais de runner. Agendamento, alertas e operação remota da limpeza de objetos continuam pendentes.

Aplicar as migrações e atualizar o frontend juntos: os novos fluxos revogam INSERT e DELETE diretos em `photos`. Não usar reset para atualizar um ambiente com dados. As fotos existentes continuam disponíveis.

Validação local em 2026-10-28: 109 testes unitários, 497 testes de banco em 15 arquivos, lint, TypeScript, build, auditoria de dependências (zero vulnerabilidades) e 10 testes E2E aprovados. O E2E de compartilhamento cobre links sem fotos prontas, renovação com invalidação do endereço anterior, mensagens WhatsApp, PIN, seleção, downloads e notificações enviadas ao Mailpit local. O fluxo de envio de fotos também cobre cota pré-validada, progresso agregado do lote, retomada, TUS, exclusão recuperável e isolamento entre workspaces. A entrada e conclusão da fila de seleções, retorno de uma nova versão para conferência e três e-mails reais ao Mailpit (duas seleções recebidas pelo fotógrafo e um pedido de ajustes ao cliente vinculado) também foram validados. O alvo Docker de produção foi construído e executado localmente; o container não privilegiado respondeu ao healthcheck e serviu HSTS e CSP com nonce. Em 2026-10-29, um backup novo foi restaurado num Supabase temporário com 6 usuários Auth, 41 tabelas e 7 objetos; duas fotos restauradas e o acesso de membro foram conferidos, e o E2E completo de login, envio, processamento, galeria pública, seleção e download passou. A instância temporária foi removida. A CI agora inclui o smoke test da imagem de produção e esse ensaio de restauração; a primeira execução remota do workflow e a experiência em celulares reais continuam pendentes.

O E2E de upload também simula a indisponibilidade temporária de um original, confirma que o worker agenda nova tentativa e valida o processamento depois que o arquivo é restaurado.

Em 2026-10-29, a prévia interativa da marca foi validada com lint, TypeScript e o E2E de compartilhamento, incluindo a alteração do nome e da cor antes de salvar.

O E2E de compartilhamento simula falha SMTP para os avisos de uma galeria, valida o retry e a entrega posterior pelo Mailpit e confirma que uma execução seguinte não reenvia avisos concluídos.

Em 2026-10-29, os E2E de compartilhamento e clientes passaram com o progresso de primeira entrega: verificaram as etapas após envio, o desaparecimento após criar um link ativo, a orientação inicial sem galeria e a ausência de rolagem horizontal em viewport móvel. Lint, TypeScript e build de produção também passaram.

Referências técnicas: [remoção de objetos pelo Storage](https://supabase.com/docs/guides/storage/management/delete-objects), [privilégios de funções de banco](https://supabase.com/docs/guides/database/functions), [diretório de build do Next.js](https://nextjs.org/docs/app/api-reference/config/next-config-js/distDir) e [tsconfigPath](https://nextjs.org/docs/app/api-reference/config/next-config-js/typescript#tsconfigpath).

Em 2026-10-29, a seleção de fotos ganhou observações opcionais por imagem e uma ação para limpar todas as escolhas do rascunho. A limpeza exige confirmação, respeita o PIN, o estado do link e o envio, apaga as observações associadas e preserva o histórico das versões enviadas. A validação local passou com lint, TypeScript, 122 testes unitários, 545 testes de banco e o E2E de compartilhamento em build de produção.

Em 2026-10-29, as mutações da seleção pública passaram a compartilhar um teto de 300 gravações por minuto por link no banco, incluindo operações via RPC direto. O estado privado expira após 24 horas sem atividade e a API devolve 429 com Retry-After. Banco: 545 testes; o E2E de compartilhamento passou em build de produção.

Em 2026-10-29, a proteção por IP passou a exigir em produção um cabeçalho explicitamente confiável e sobrescrito pelo proxy. Cadeias de `x-forwarded-for` são rejeitadas; o preflight e `/api/ready` sinalizam configuração ausente ou inválida. Lint, TypeScript, 127 testes unitários e os E2E de prontidão e compartilhamento passaram em build de produção.

Em 2026-10-29, avisos de seleção que falham após cinco tentativas automáticas podem ser reenfileirados manualmente até duas vezes pelo workspace. A operação reutiliza o evento, busca o e-mail atualizado no cadastro e só permite pedidos de ajuste enquanto o link ainda está válido; o limite e o isolamento da fila são aplicados no banco. A migração local foi aplicada sem reset; passaram lint, TypeScript, 127 testes unitários, 553 verificações de banco e os E2E de compartilhamento e prontidão. `/api/ready` respondeu pronto após reiniciar o servidor local de desenvolvimento.
