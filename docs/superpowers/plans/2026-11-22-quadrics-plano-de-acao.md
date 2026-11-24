# Plano de ação do Quadrics

**Objetivo.** Entregar um MVP pronto para um piloto com dois ou três fotógrafos, com galerias privadas, portfólio público, arquivos no R2 e operação acompanhada na Azure.

**Arquitetura proposta.** Manter Next.js, TypeScript, Supabase Auth e PostgreSQL com controles de acesso por estúdio. Preparar o R2 como armazenamento privado e conservar a leitura dos arquivos que já estão no Supabase durante a transição. Rodar a aplicação e a manutenção em containers separados na Azure. Registrar a decisão de manter as migrações SQL atuais em vez de introduzir Prisma no MVP.

**Referências.** Documento Mestre do Quadrics, [roteiro de adaptação](../../14-adaptacao-quadrics.md) e [infraestrutura e segurança](../../13-infraestrutura-seguranca.md).

## Ponto de partida

- **No código:** marca Quadrics, cadastro, painel por estúdio, clientes, galerias, upload com retomada, processamento de fotos, links com PIN, seleção, downloads autorizados e portfólio público básico.
- **Preparado para evoluir:** camada de leitura de mídia, fluxo de upload separado do transporte e Compose de produção com proxy e manutenção agendada.
- **Pendente de execução:** linha de base validada com as alterações atuais, integração R2, aplicação das migrações de marca e portfólio no ambiente, implantação e ensaio do piloto.

## Entrega 1 — Consolidar a base local

**Prioridade imediata.** Serve de referência para comparar as mudanças seguintes.

- [x] Inventariar as alterações existentes no repositório. Revisar por frente: marca e portfólio, armazenamento, testes e infraestrutura. Preservar o trabalho em andamento.
- [x] Aplicar as migrações pendentes no Supabase local. As migrações de marca e portfólio foram aplicadas sem reset; as contagens de contas, estúdios, galerias, fotos e links ficaram iguais antes e depois.
- [x] Registrar lint, TypeScript, build, testes unitários, testes de banco e testes de ponta a ponta. Registrar falhas com cenário, resultado e correção.
- [x] Exercitar em testes locais o ciclo do fotógrafo, desde o cadastro até o envio de fotos, e a visão móvel do cliente sem conta para seleção e entrega, PIN, expiração e downloads. Confirmar isolamento entre estúdios. Repetir em celulares reais na homologação.
- [x] Confirmar que rascunhos do portfólio e fotos excluídas da seleção ficam indisponíveis pelo endereço direto da imagem. Conferir publicação e apresentação em viewport móvel.

**Concluída quando:** há uma versão de referência que pode ser construída e reproduzida, com os fluxos críticos e as permissões validados.

**Registro local em 22/11/2026.** As duas migrações foram aplicadas incrementalmente. Antes e depois, o banco tinha 7 contas, 4 estúdios, 3 galerias, 2 fotos e 3 links. Next.js e `eslint-config-next` foram atualizados para 16.4.6 depois que o verificador de segurança bloqueou o primeiro build do Playwright. Um teste da limpeza de limites de acesso foi isolado dos registros antigos encontrados no banco local. Passaram lint, TypeScript, build de produção usado pelo Playwright, 131 testes unitários, 568 verificações de banco e os 10 testes no navegador. A auditoria do npm não reportou alertas nas dependências de produção e listou sete moderados na árvore de desenvolvimento.

## Entrega 2 — Preparar a transição de armazenamento no código

**Depende da Entrega 1.** Desenvolver e verificar localmente antes de ativar o R2.

- [x] Registrar a origem dos arquivos nas sessões e fotos. A migração `20261218000100_photo_storage_provider.sql` mantém os registros legados no Supabase, e a confirmação grava na foto o provedor da sessão. Só o Supabase está habilitado. Validar o mesmo contrato com dois provedores antes da ativação do R2.
- [x] Separar a consulta de metadados do Supabase da finalização no PostgreSQL. A rotina privada compara provedor, chave, tamanho e tipo com a reserva.
- [x] Preparar o leitor autenticado de metadados do R2. Validar provedor, formato da chave e os metadados retornados com testes simulados, mantendo o leitor fora do fluxo ativo.
- [x] Conectar a consulta de metadados à finalização privada em um módulo de servidor, com nova verificação de escopo no banco. Registrar o ETag e recusar tentativas de confirmação repetida com metadados diferentes. Manter desligados os endpoints e as reservas do R2.
- [x] Preparar URLs de envio simples com escrita condicional e leitura do worker condicionada ao ETag registrado. Verificar a assinatura, os limites da reserva e respostas de objeto substituído com testes simulados.
- [x] Usar o ETag também no download individual e no ZIP, com transmissão em fluxo, identidade por arquivo no manifesto e reconciliação de pacotes interrompidos.
- [x] Registrar autorizações antes de assinar um PUT e separar a reconciliação por provedor. Liberar sessões R2 expiradas sem autorização e conservar a cota das sessões que ainda podem gerar um arquivo.
- [x] Preparar as operações do R2 por partes em código local. Assinar partes pelo tamanho esperado, conferir a lista real antes de concluir, exigir criação condicional e verificar encerramento explícito do identificador após abortar.
- [ ] Persistir intenção e identificador da transferência por partes no banco. Garantir que não há conclusão concorrente nem objeto órfão antes de liberar a cota. Aplicar a regra também à exclusão de galeria ou estúdio.
- [ ] Em `src/lib/media-storage.ts`, no worker de imagens e nas rotinas de manutenção, explicitar a origem dos objetos lidos, produzidos e removidos. Cobrir o acesso do painel, galeria pública, portfólio, download individual, ZIP, auditoria e backup. Derivados e logos podem continuar no Supabase na primeira ativação, com origem registrada ou configurada de forma explícita.

**Concluída quando:** a aplicação segue operando integralmente com o Supabase e sabe distinguir a origem de uma foto ou envio, sem alterar o comportamento de registros legados.

**Verificação local em 23/11/2026.** Passaram lint, TypeScript, 157 testes unitários, 607 verificações de banco e 10 testes no navegador. O Compose foi validado, a imagem web foi construída e o container respondeu às verificações locais. A auditoria do npm encontrou zero alertas nas dependências de produção e sete moderados na árvore de desenvolvimento. Um backup criptografado foi verificado e restaurado em uma instância descartável, com 42 tabelas, 7 objetos e acesso aos originais e às prévias. O teste de ponta a ponta da cópia restaurada passou e a instância descartável foi removida. As operações R2 foram simuladas; o provedor permanece desativado.

## Entrega 3 — Integrar e validar o R2

**Depende da Entrega 2.** Configurar primeiro um bucket privado de homologação. Os segredos ficam no servidor.

- [ ] Criar o transporte R2 e habilitar somente por configuração. Emitir autorizações temporárias restritas à operação e à chave reservada. Usar upload direto e, para arquivos grandes, guardar o identificador do envio por partes e permitir retomar após queda de conexão.
- [ ] Com os dois provedores, validar envio pequeno, retomada, confirmação repetida, arquivo divergente, expiração e descarte. Exercitar processamento, miniaturas, download, ZIP com objetos dos dois provedores, exclusão e restauração.
- [ ] Antes de decidir sobre arquivos existentes, inventariar o volume e a origem. Se forem copiados, preservar as chaves, verificar quantidade, integridade e leitura no destino e só então atualizar as referências. Manter as cópias de origem durante o período de observação.
- [ ] Ensaiar a volta do padrão de novos envios ao Supabase. Sessões em andamento e arquivos já gravados no R2 devem continuar acessíveis pelo provedor registrado.

**Concluída quando:** o R2 funciona para originais novos em homologação, o acervo anterior continua acessível e o caminho de retorno foi ensaiado.

## Entrega 4 — Homologar na Azure

**Pode começar junto da Entrega 1.** A validação final do MVP usa a Entrega 3.

**Capacidade da VPS em aberto.** Comparar 1 vCPU e 1 GB com 2 vCPUs e 4 GB depois de medir o fluxo do piloto. O dimensionamento não impede as entregas locais.

- [ ] Resolver o acesso administrativo à VPS, definir hostname e preparar Supabase de homologação separado dos dados reais. Configurar DNS, HTTPS, URLs de autenticação, SMTP e segredos.
- [ ] Subir o servidor e a manutenção com `compose.production.yaml` e os arquivos em `deploy/`. Aplicar migrações, confirmar `/api/ready` e acompanhar as filas e o consumo de memória e CPU.
- [ ] Configurar backups fora da VPS e ensaiar restauração em um ambiente isolado. Registrar com que frequência há cópias, quanto de dado pode ser perdido e em quanto tempo o ambiente pode ser recuperado.
- [ ] Medir tempo de abertura da galeria no celular, tempo do upload até aparecer a prévia, uso da VPS e falhas de notificação. Usar galerias pequenas e uma galeria representativa de um ensaio real. Registrar a linha de base e ajustar concorrência ou recursos com base nos números.
- [ ] Comparar as configurações com o mesmo build, lote e volume de acessos. Fazer upload de fotos grandes enquanto outra pessoa navega e baixa um ZIP. Registrar pico de CPU e memória, reinícios, tempo de geração de prévias e se a fila volta ao normal. Incluir o custo para escolher a menor configuração que mantenha o fluxo estável com folga.

**Concluída quando:** o fluxo completo roda pelo endereço HTTPS, há alertas operacionais e uma cópia de segurança já foi restaurada com sucesso.

## Entrega 5 — Piloto e preparação comercial

- [ ] Convidar dois ou três fotógrafos e acompanhar trabalhos completos. Medir quantos conseguem publicar e entregar uma galeria sem ajuda, quantos concluem seleção ou download e quais problemas se repetem.
- [ ] Registrar o custo mensal de hospedagem, armazenamento e tráfego e como ele varia com cada fotógrafo ativo. Corrigir primeiro bloqueios de entrega, risco de perda ou exposição de dados e dificuldades no celular.
- [ ] Usar o piloto para definir o próximo ciclo. Antes de cobrar, preparar planos, limites comerciais, painel administrativo, assinatura, gateway, termos, privacidade e retenção. Venda de fotos, domínios próprios, personalização avançada e app/PWA entram em ciclos posteriores conforme a demanda.

**Concluída quando:** o piloto tem entregas reais registradas, problemas priorizados e dados suficientes para decidir quando iniciar a etapa comercial.

## Critérios para colocar o MVP em uso

Um fotógrafo deve conseguir criar conta, publicar seu portfólio, enviar fotos, compartilhar uma galeria e concluir uma entrega. O cliente deve conseguir visualizar, selecionar quando solicitado e baixar o que foi autorizado, pelo celular e sem criar conta. O isolamento entre estúdios, o armazenamento privado, a observação da operação e a restauração do ambiente fazem parte da aceitação.
