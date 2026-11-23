# Infraestrutura, confiabilidade e segurança

Este documento descreve os controles disponíveis no repositório e o que ainda precisa ser configurado no ambiente antes de um piloto. A configuração local não substitui uma validação em hospedagem com TLS, proxy e segredos próprios.

## Controles implementados

- `Dockerfile` tem um alvo `runner` para produção com saída standalone do Next.js, usuário sem privilégios e healthcheck de liveness. O alvo `development` mantém `npm run dev` e os workers locais; o Compose usa esse alvo.
- O build de produção exige `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` como argumentos. São configurações públicas embutidas no JavaScript do navegador; não passe `SUPABASE_SERVER_SECRET_KEY` como argumento de build. Injete a chave privada somente em tempo de execução por um gerenciador de segredos.
- O container verifica `/api/health` para liveness. O balanceador ou plataforma deve consultar `/api/ready` para verificar o banco e os quatro buckets privados.
- O processo de produção valida `QUADRICS_APP_URL`, as chaves pública e privada do Supabase e o remetente SMTP antes de iniciar o servidor; URLs precisam usar HTTPS e o SMTP não pode desativar TLS.
- Logos enviados pelo proprietário são decodificados, limitados a 20 milhões de pixels, redimensionados e convertidos para WebP sem metadados. O bucket de marca permanece privado; páginas de workspace exigem associação autenticada e galerias públicas consultam uma função que valida token, expiração, revogação, PIN e limite de requisições antes de devolver o caminho exato.
- Páginas HTML do app recebem uma CSP por requisição com nonce criptográfico. O cliente Supabase e o Storage configurados entram em `connect-src` e `img-src`; `style-src-attr 'unsafe-inline'` permanece necessário para as cores de marca validadas do estúdio. Em produção, a política não permite `unsafe-eval`.
- HSTS é enviado quando `NODE_ENV=production`. A aplicação ainda precisa ficar atrás de um proxy que encerre TLS e bloqueie HTTP externo.
- Links de confirmação e recuperação usam `QUADRICS_APP_URL` canônico em produção. Deve ser uma origem HTTPS sem caminho ou parâmetros; a aplicação não confia em `Host` para compor links de e-mail. HTTP em loopback continua permitido para ensaios locais.
- O E2E de restauração exige credenciais de uma instância local descartável e é separado da suíte E2E padrão. Use `npm run backup:restore-e2e -- --backup <diretório-ou-arquivo-cartlio.enc>` para o ensaio completo; em backups cifrados, defina `QUADRICS_BACKUP_PASSPHRASE`. O ensaio injeta as credenciais temporárias e remove a instância ao terminar. A CI cria uma conta sintética antes do backup e verifica, na cópia restaurada, login com a senha original e acesso ao workspace; o ensaio também percorre o login e a entrega com uma conta nova.
- O CI executa `npm audit --audit-level=high`, lint, TypeScript, testes unitários, build e smoke test da imagem de produção, testes do banco, fluxos E2E padrão e ensaio de restauração isolada.
- Dependabot verifica semanalmente dependências npm e GitHub Actions; cada atualização passa pelo CI antes de revisão e merge.
- As GitHub Actions do workflow estão fixadas em SHAs completos das releases oficiais; o Dependabot acompanha novas versões. Tags móveis não alteram o código executado sem uma mudança revisada no repositório.

## Validação local

Em 2026-10-28, passaram 109 testes unitários, 497 testes de banco em 15 arquivos, lint, TypeScript, build, 10 testes E2E, `npm audit` (zero vulnerabilidades) e `docker compose config`. O alvo Docker `runner` também foi construído e iniciado: o container roda como usuário `nextjs`, ficou saudável, respondeu em `/api/health` e serviu HSTS e CSP com nonce. A imagem e o container temporários usados nessa validação foram removidos.

O contexto Docker anterior incluía build E2E e traces de navegador e chegava a 189 MB. `.dockerignore` agora exclui `.next-e2e`, `test-results` e `playwright-report` para reduzir o envio do contexto e evitar empacotar artefatos de teste.

Os builds E2E usam `node_modules/.cache/quadrics-next-e2e` e `tsconfig.e2e.json`, para não gerar arquivos observáveis pelo servidor local nem alterar a configuração TypeScript principal. O runner restaura `next-env.d.ts` e os dois `tsconfig` mesmo se o build falhar. `npm run typecheck` gera os tipos de rota com `next typegen` antes de executar o TypeScript.

Em 2026-10-29, o ensaio local cifrou um backup novo e o restaurou em projeto isolado: 7 usuários Auth, 41 tabelas e 7 objetos. Foram validados dois registros de fotos existentes, acesso de membro, galeria e downloads; no navegador, a conta sintética manteve a senha do backup e abriu seu workspace. O E2E também validou login de uma conta nova, envio/processamento, seleção do cliente e download. A conta sintética da origem, o backup cifrado temporário e a instância restaurada foram removidos ao final. A CI agora inclui o mesmo login com uma conta sintética; uma restauração de backup real no ambiente hospedado continua pendente.

Em 2026-10-29, o isolamento dos builds E2E foi validado com o servidor de desenvolvimento ativo: o E2E de prontidão passou, `/api/ready` continuou respondendo 200 e os hashes de `next-env.d.ts`, `tsconfig.json` e `tsconfig.e2e.json` permaneceram iguais antes e depois do build. Também passaram lint, TypeScript e 129 testes unitários.

Em 2026-10-30, a migration de reconciliação dos ZIPs foi aplicada ao Supabase local sem reset. Passaram 558 verificações de banco, 131 testes unitários, lint e TypeScript. O E2E de compartilhamento exerceu downloads ZIP, mas falhou depois numa expectativa do worker SMTP (código de saída 0 onde o teste esperava 1); esse trecho precisa ser repetido com a fila local isolada.

## Build do container de produção

Gere uma imagem por ambiente, pois as variáveis `NEXT_PUBLIC_*` são embutidas pelo Next.js durante o build. Passe somente os valores públicos do projeto:

```powershell
docker build --target runner `
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://<projeto>.supabase.co `
  --build-arg NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<chave-publica> `
  --build-arg NEXT_PUBLIC_SUPABASE_STORAGE_URL=https://<projeto>.storage.supabase.co `
  -t quadrics-web:local .
```

Em produção, injete `SUPABASE_SERVER_SECRET_KEY` e as credenciais `QUADRICS_SMTP_*` pelo mecanismo de segredos do host; defina `QUADRICS_APP_URL` e `QUADRICS_TRUSTED_CLIENT_IP_HEADER` na configuração de runtime. O alvo `runner` contém somente o servidor web; workers de manutenção e imagens devem rodar como processos agendados separados usando os scripts `--remote`.

Use um proxy reverso à frente do Next.js para terminar TLS, limitar o tamanho e a duração de requisições e impor limites por IP. Em produção, configure `QUADRICS_TRUSTED_CLIENT_IP_HEADER` com exatamente um destes nomes: `cf-connecting-ip`, `x-real-ip` ou `x-forwarded-for`. O proxy precisa remover o valor recebido do visitante e sobrescrever o cabeçalho escolhido com um único endereço IP validado. Se usar `x-forwarded-for`, encaminhe só o endereço do cliente; cadeias de IP são rejeitadas. O preflight de produção impede o servidor de iniciar quando essa configuração está ausente ou inválida. Se o serviço web tiver mais de uma réplica, configure a mesma `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` para todas elas e mantenha cada réplica no mesmo build.

## Trabalho necessário antes do piloto

- Criar staging e produção isolados, definir o domínio canônico em `QUADRICS_APP_URL` e configurar HTTPS, URLs de redirecionamento do Supabase e SMTP de produção.
- Agendar o runner de manutenção e acompanhar idade das filas e falhas. `npm run maintenance -- --remote` é uma execução única; ele não cria o agendamento nem envia alertas de prontidão.
- Definir backup remoto criptografado e fora do host, retenção, RPO e RTO. O backup e o ensaio atuais cobrem o Supabase local; não substituem uma rotina de cópia e restauração do ambiente hospedado.
- Confirmar a suíte padrão e o ensaio de restauração na primeira execução da CI, com a versão atual das migrations. A execução remota da CI e a restauração a partir de um backup de produção ainda não foram validadas.
- Verificar CSP, fluxo de upload, compartilhamento, recuperação de conta e downloads no domínio final e em celulares reais. A CSP usa nonce e torna as respostas HTML dinâmicas e não armazenáveis em cache; medir o efeito no domínio de produção.
- Configurar alertas para `/api/ready`, falhas do runner, tentativas repetidas de PIN, idade de envios pendentes e divergências detectadas pela auditoria do Storage.
- Monitorar respostas HTTP 429 de imagens e gravações de seleção e revisar os limites com dados reais do piloto; o teto de seleção é agregado por link.
- Configurar `QUADRICS_TRUSTED_CLIENT_IP_HEADER` junto ao proxy, confirmar que ele remove cabeçalhos enviados pelo cliente e validar que a limitação por IP não pode ser contornada.

## Homologação na Azure

O arquivo `compose.production.yaml` prepara três serviços: Next.js na rede privada do Compose, Caddy nas portas 80 e 443 e um container de manutenção acionado pelo systemd. O Caddy usa HTTPS automático e grava o endereço do cliente em `X-Real-IP`. A configuração inicial pressupõe que o DNS aponta diretamente para a VM. Com o proxy da Cloudflare ativo, configure os proxies confiáveis e confirme que o IP do visitante chega ao aplicativo antes de habilitar a proteção por IP.

Na VM Ubuntu, com Docker, Compose e os arquivos da versão em `/opt/quadrics`:

1. Aponte um hostname para a VM e autorize entrada HTTP e HTTPS na Azure. Crie `.env.production.local` com permissão restrita a partir de `.env.example`. Preencha `QUADRICS_HOST` com o hostname, `QUADRICS_APP_URL` com sua URL HTTPS, as credenciais do projeto Supabase de homologação e o SMTP. Cadastre as URLs de autenticação no Supabase e aplique as migrações.
2. Execute `docker compose --env-file .env.production.local -f compose.production.yaml --profile maintenance build` e depois `docker compose --env-file .env.production.local -f compose.production.yaml up -d`.
3. Copie `deploy/quadrics-maintenance.service` e `deploy/quadrics-maintenance.timer` para `/etc/systemd/system/`. Ajuste o diretório na unidade se necessário. Execute `sudo systemctl daemon-reload` e `sudo systemctl enable --now quadrics-maintenance.timer`. Consulte o histórico com `journalctl -u quadrics-maintenance.service`.
4. Confira `/api/ready`, os fluxos de autenticação e galeria, o portfólio publicado e a remoção de imagens após despublicação. Configure limites de requisições no ponto de entrada antes de expor o piloto e acompanhe o uso da VPS e das filas.

A configuração está no repositório. A implantação depende dos acessos à Azure e ao Supabase, do domínio e dos segredos de homologação.
