# Clientes e galerias

O cadastro pode guardar um WhatsApp opcional em formato internacional (por exemplo, `+55 11 99999-9999`). O Quadrics normaliza o número, mantém-no privado aos membros do workspace e o usa apenas como destinatário de mensagens pré-preenchidas para compartilhar a galeria ou pedir uma revisão. O fotógrafo ainda confirma o envio no WhatsApp; o número não é mostrado ao visitante.

Galerias recorrentes podem ser reutilizadas como modelo: a cópia recebe endereço exclusivo e começa como rascunho, mantendo título e descrição como ponto de partida. Cliente, capa, fotos, links e histórico ficam fora da cópia.

## Escopo

- Dentro de cada workspace, a aba **Clientes** permite cadastrar e editar nome, e-mail e WhatsApp opcionais, filtrar cadastros sem um canal de contato, ver quantas galerias estão associadas e abrir o painel já filtrado pelos trabalhos daquele cliente. Quando a busca não retorna clientes, a tela diferencia filtros sem resultado de um workspace sem cadastros e oferece um atalho para limpar os filtros.
- A exportação CSV inclui todos os clientes do workspace ou todos os resultados dos filtros atuais, com limite de 25.000 registros. Os campos textuais são escapados contra fórmulas de planilha e a resposta não pode ser armazenada em cache.
- As listas de clientes e galerias podem ser filtradas sem sair do workspace; clientes por nome, e-mail ou WhatsApp, além de canais de contato ausentes, e galerias por título (tratando `%` e `_` como texto literal), status e cliente, incluindo galerias sem cliente vinculado. Cada página carrega até 25 registros e preserva os filtros ao navegar.
- O vínculo de cliente na criação/edição de galerias e o filtro do painel buscam por nome, e-mail ou WhatsApp sob demanda: a consulta exige dois caracteres, retorna até 20 resultados e é limitada ao workspace autenticado, sem carregar o cadastro completo no formulário.
- Clientes sem galerias associadas podem ser excluídos; primeiro desvincule as galerias que ainda usam o cadastro.
- A aba **Galerias** lista os trabalhos e permite criar e editar título, identificador interno, descrição, cliente principal opcional e status. Ao criar, o identificador acompanha o título e remove acentos; pode ser ajustado manualmente. O link do cliente é criado separadamente em **Compartilhar**.
- Status disponíveis: rascunho, publicada e arquivada. É possível retornar a um estado anterior.
- Publicada é um estado interno: permite ao fotógrafo criar links temporários de compartilhamento, mas não cria um link automaticamente nem concede acesso anônimo.
- Cada galeria possui, nesta fase, no máximo um cliente principal. O modelo de múltiplos clientes do blueprint fica para uma etapa posterior.
- O identificador é único dentro do workspace; workspaces diferentes podem reutilizá-lo. Ele aparece nos cards como referência para a equipe e não é o link de acesso do cliente.
- A edição da galeria agora oferece envio de originais JPEG/PNG privados e permite reenviar novas fotos enquanto a galeria não estiver arquivada.
- Na edição, o fotógrafo pode definir uma capa entre as fotos prontas; sem escolha, a capa segue a primeira foto na ordem da grade. Remover a capa selecionada faz a galeria voltar à seleção automática.
- A ordem pode ser ajustada arrastando a alça de cada foto ou usando **Subir** e **Descer**; a mesma ordem aparece para o cliente.
- O painel mostra uma prévia privada da capa escolhida ou da primeira foto pronta; galerias sem fotos exibem um estado vazio. Os cards também destacam falhas, envios pendentes e seleções recebidas para conferência.
- Owner e editor podem gerenciar clientes e galerias. Exclusão não está exposta; galerias podem ser arquivadas.

## Banco e autorização

A migração `20261022000100_customers_galleries.sql` adiciona `customers`, `galleries` e `gallery_status`. Todas as consultas usam sessão do usuário e RLS. As ações revalidam identidade e acesso ao workspace, e filtram updates por workspace e registro.

A FK `(tenant_id, customer_id)` impede associar clientes de outro workspace, mesmo quando o usuário participa dos dois. Grants por coluna impedem alterar `tenant_id`, `id` ou `created_at`. Visitantes anônimos não têm acesso às tabelas, independentemente do status da galeria.

## Executar

Siga a [configuração de contas e workspaces](02-autenticacao-workspaces.md). Em um banco local já existente, execute `npx supabase migration up --local` para aplicar a nova migração sem apagar dados.

Validações:

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run db:test
```

Os testes unitários usam o suporte de remoção de tipos do Node.js; execute-os com Node 22.6+ (a imagem Docker e a CI usam Node 22). A aplicação continua seguindo os requisitos do Next.js.

## Roteiro de aceite

1. Entre, crie um workspace e cadastre um cliente com nome e e-mail.
2. Abra o cliente na lista, altere o nome e salve.
3. Crie uma galeria, selecione o cliente e confira os dados na edição.
4. Publique, recarregue e confirme o status; repita com arquivamento.
5. Tente criar outra galeria com o mesmo endereço; deve aparecer uma mensagem de conflito.
6. Entre com outra conta e tente abrir a URL anterior; os dados devem permanecer indisponíveis.
7. No workspace da segunda conta, tente abrir o ID da galeria da primeira; deve aparecer “Galeria não encontrada”.

Links temporários para clientes, seleção de fotos e autorização de downloads dos originais escolhidos estão disponíveis; consulte [compartilhamento](08-compartilhamento-galerias.md), [seleção](09-selecao-fotos.md) e [downloads autorizados](10-downloads-autorizados.md).

## Validação realizada

- Migrações aplicadas no Supabase local sem reset.
- 43 testes pgTAP passaram: 19 anteriores e 24 de clientes/galerias.
- Cinco testes unitários de validação de clientes e galerias passaram; quatro testes adicionais cobrem a busca por nome/e-mail e caracteres especiais tratados como texto literal.
- Dois testes unitários cobrem a exportação CSV, incluindo compatibilidade com planilhas e neutralização de fórmulas.
- A busca de galerias trata `%`, `_` e barra invertida como texto literal; os testes unitários e o E2E de paginação cobrem esse comportamento.
- TypeScript e build de produção passaram; lint sem erros, com um aviso preexistente no PostCSS.
- O E2E de clientes passou pelo bloqueio de visitantes, cadastro/edição, filtros de contato, estado sem resultados, busca por nome/e-mail/WhatsApp, exportação dos resultados filtrados em CSV e exclusão protegida por confirmação. A suíte E2E da plataforma também cobre contagem de vínculos, criação, publicação, arquivamento, endereço duplicado, logout/login e isolamento entre contas.
- O seletor assíncrono foi validado no navegador: busca e vínculo ao criar uma galeria, preservação do cliente na edição e filtro do painel; os E2E de compartilhamento e duplicação passaram com o novo campo.
- A lista de galerias foi verificada em viewport de 390 × 844, sem rolagem horizontal. Contas e dados criados pelo teste foram removidos ao terminar.
- A CI foi atualizada para incluir os testes unitários; sua execução remota não foi observada.
