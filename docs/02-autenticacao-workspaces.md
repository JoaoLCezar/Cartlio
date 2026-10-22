# Contas e workspaces

## Implementação

- `/cadastro`: cadastro por e-mail e senha; quando a confirmação está ativa, orienta a confirmar o e-mail e entrar.
- `/login`: entrada por senha.
- `/auth/callback`: troca de código PKCE quando o provedor redirecionar para esta rota. Destino fixo no painel.
- `/painel`: perfil, lista de workspaces e criação de workspace.
- `/painel/[id]`: workspace visível apenas aos seus membros; resposta 404 para IDs inexistentes ou sem acesso.
- Logout via Server Action, sem mutação por GET.

Todas as ações protegidas validam o usuário com `getUser`. Consultas usam a chave pública e a sessão do usuário; nenhuma chave privilegiada é necessária. O Proxy renova os cookies e impede cache compartilhado das rotas de sessão. A criação de workspace usa exclusivamente a função SQL transacional existente.

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

Execute `npm run lint`, `npm run typecheck`, `npm run build` e, com Supabase local ativo, `npm run db:test`.

Verificação manual com duas contas:

1. Cadastre A; confirme o e-mail se exigido, entre e salve o perfil.
2. Crie um workspace; confirme sua presença na lista e na página própria.
3. Tente um endereço repetido e confirme a mensagem de conflito.
4. Saia e entre como B; a lista não pode mostrar o workspace de A.
5. Abra a URL do workspace de A como B; a resposta deve ser 404.
6. Saia e tente abrir `/painel`; deve redirecionar ao login.
7. Confirme que atualizar a página mantém a sessão e que erros de acesso não exibem dados internos.

Galerias, recuperação de senha, convites e transferência de propriedade ainda não fazem parte desta entrega. Antes de um beta público, validar entrega de e-mail, limites de autenticação e recuperação de conta.

## Verificações realizadas nesta entrega

- TypeScript e build de produção passaram.
- ESLint passou sem erros; permanece um aviso preexistente de exportação anônima em `postcss.config.mjs`.
- Smoke HTTP sobre o build: landing, login, cadastro e health responderam; painel sem configuração/sessão redirecionou ao login, inclusive no acesso direto a um workspace. Callback sem código também retornou ao login, ignorando um destino externo fornecido na query.
- Os 19 testes pgTAP e o fluxo com contas reais não foram executados neste ambiente: o Docker Desktop retornou `Docker Desktop is unable to start`. A CI foi adicionada, mas sua execução remota ainda não foi observada.
