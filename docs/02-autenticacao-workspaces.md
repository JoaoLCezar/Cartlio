# Contas e workspaces

## Implementação

- `/cadastro`: cadastro por e-mail e senha; quando a confirmação está ativa, orienta a confirmar o e-mail e entrar.
- `/login`: entrada por senha.
- `/recuperar-senha`: solicita por e-mail um link de redefinição, sem revelar se a conta existe.
- `/auth/callback`: troca de código PKCE e aceita somente o destino interno de redefinição ou um convite válido; os demais seguem para o painel.
- `/redefinir-senha`: exige uma sessão de recuperação válida e grava a nova senha.
- `/painel`: perfil, lista de workspaces e criação de workspace.
- `/painel/[id]`: workspace visível apenas aos seus membros; resposta 404 para IDs inexistentes ou sem acesso.
- `/painel/[id]/equipe`: somente o proprietário consulta os membros e seus papéis, remove colaboradores, transfere a propriedade para um colaborador existente, gera ou revoga convites e vê as últimas 50 ações de equipe. A remoção preserva o proprietário e encerra imediatamente o acesso do colaborador; a transferência torna o novo titular proprietário e rebaixa o anterior para colaborador. Cada link de convite é de uso único, expira em sete dias, fica vinculado ao e-mail e pode ser copiado para envio manual.
- `/convite/[token]`: o convidado entra ou cria uma conta; só uma conta confirmada com o e-mail correspondente pode aceitar. A aceitação adiciona o papel `editor`, e apenas o hash do token fica armazenado.
- Logout via Server Action, sem mutação por GET.

## Papéis do workspace

O produto tem dois papéis. O proprietário pode fazer tudo que um colaborador faz e também gerenciar membros e convites, consultar o histórico de equipe, transferir a propriedade e alterar a marca pública do estúdio. O colaborador (`editor`) pode gerenciar clientes, galerias, fotos, uploads, compartilhamentos e seleções; pode visualizar a marca, mas não alterá-la. A equipe e seu histórico ficam ocultos para colaboradores, e as rotas de gerenciamento são negadas. Não há permissões configuráveis por ação: convide como colaborador apenas quem deve ter acesso operacional às galerias e aos clientes do workspace.

Todas as ações protegidas validam o usuário com `getUser`. Consultas usam a chave pública e a sessão do usuário; nenhuma chave privilegiada é necessária. O Proxy renova os cookies e impede cache compartilhado das rotas de sessão. A criação de workspace usa exclusivamente a função SQL transacional existente. Após login, cadastro ou confirmação de e-mail, o redirecionamento só preserva o caminho interno de um convite com formato válido; destinos externos são descartados.

Os convites não enviam e-mail automaticamente. O proprietário copia o link e o envia pelo canal que preferir; a lista exibe apenas convites pendentes, sem revelar tokens anteriores. Reemitir um convite para o mesmo endereço invalida o link anterior. A transferência só pode ser feita para alguém que já aceitou o convite e consta como colaborador.

Referência de integração: [Supabase SSR para Next.js](https://supabase.com/docs/guides/auth/server-side/creating-a-client).

## Configuração local

1. Instale as dependências com `npm ci`.
2. Com Docker disponível, execute `npm run db:start` e aplique as migrações com `npx supabase migration up`. Não é necessário apagar um banco existente.
3. Execute `npx supabase status` para obter URL da API e chave pública (publishable ou anon legada).
4. Copie `.env.example` para `.env.local` e preencha a chave pública. Nunca use secret/service_role neste campo.
5. Execute `npm run dev` e acesse `/cadastro`.

Para executar a aplicação no Docker: `docker compose --env-file .env.local up --build`. Nesse caso, configure a URL como `http://host.docker.internal:54321` para alcançar o Supabase do host. A chave é a mesma. As configurações de Auth devem permitir a origem utilizada pelo navegador; o padrão local é `http://localhost:3000`.

Sem as variáveis, a landing e o health continuam disponíveis; as páginas de entrada mostram indisponibilidade e o painel redireciona para login. Reinicie o processo após editar o ambiente.

## Validação

Execute `npm run lint`, `npm run typecheck`, `npm run build` e, com Supabase local ativo, `npm run db:test`. O E2E de equipe é `npm run test:e2e -- tests/e2e/workspace-invitations.spec.ts`.

Verificação manual com duas contas:

1. Cadastre A; confirme o e-mail se exigido, entre e salve o perfil.
2. Crie um workspace; confirme sua presença na lista e na página própria.
3. Tente um endereço repetido e confirme a mensagem de conflito.
4. Saia e entre como B; a lista não pode mostrar o workspace de A.
5. Abra a URL do workspace de A como B; a resposta deve ser 404.
6. Saia e tente abrir `/painel`; deve redirecionar ao login.
7. Confirme que atualizar a página mantém a sessão e que erros de acesso não exibem dados internos.

Clientes e metadados de galerias foram adicionados na [etapa seguinte](03-clientes-galerias.md). A recuperação de senha usa o e-mail do Supabase Auth; no ambiente local, confira a mensagem no Mailpit. Antes de um beta público, validar entrega de e-mail, limites de autenticação e recuperação de conta.

## Verificações realizadas nesta entrega

- TypeScript e build de produção passaram.
- ESLint passou sem erros; permanece um aviso preexistente de exportação anônima em `postcss.config.mjs`.
- Smoke HTTP sobre o build: landing, login, cadastro e health responderam; painel sem configuração/sessão redirecionou ao login, inclusive no acesso direto a um workspace. Callback sem código também retornou ao login, ignorando um destino externo fornecido na query.
- Na entrega inicial, os testes de banco estavam bloqueados pela inicialização do Docker. Na etapa de clientes e galerias, o Docker voltou a funcionar e os 19 testes anteriores passaram, junto a 24 testes novos, totalizando 43 verificações SQL. A execução remota da CI ainda não foi observada.
- O teste de navegador da etapa seguinte também validou cadastro, perfil, criação de workspace, logout, login e isolamento com duas contas no Supabase local.
- A validação local da equipe cobriu lista e histórico restritos ao proprietário, remoção com perda imediata de acesso, transferência para colaborador existente, permissões antes/depois da troca e autoria dos eventos, além de criação, reemissão, revogação e aceitação de convites. As migrações foram aplicadas sem reset; a suíte SQL passou com 471 verificações, incluindo 23 casos de auditoria da equipe. TypeScript, lint, 101 testes unitários e o E2E dedicado também passaram.
- O fluxo de recuperação de senha foi validado no Supabase local: o E2E recebe o e-mail pelo Mailpit, abre o link real, troca a senha e confirma que a antiga não autentica. A suíte SQL atual passou com 230 verificações.
