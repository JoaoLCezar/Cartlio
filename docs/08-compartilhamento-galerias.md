# Compartilhamento controlado de galerias

Se a galeria estiver vinculada a um cliente com WhatsApp cadastrado, as mensagens prontas de compartilhamento e revisão abrem diretamente a conversa desse número. Sem telefone salvo, o WhatsApp abre a seleção de contato. O Quadrics nunca envia a mensagem automaticamente nem inclui o telefone no texto ou na galeria pública. Cadastre o número com código do país, conforme o formato aceito pelo [WhatsApp](https://faq.whatsapp.com/5913398998672934/?locale=pt_BR).

## Comportamento

Links sem PIN geram um cartão social JPEG de 1200 × 630 com a capa autorizada, o nome público, a cor de destaque e o logo do estúdio, quando cadastrado. A capa e o logo são incorporados somente após o banco confirmar que o link continua ativo, a foto está pronta e o compartilhamento não exige PIN; o cartão não é armazenado em cache pelo servidor. Em produção, a origem confiável do cliente precisa estar configurada no proxy para validar a busca dos arquivos de marca.

Links sem PIN incluem título, descrição e capa nas prévias de compartilhamento do WhatsApp e de outras redes. Links protegidos exibem apenas que a galeria exige PIN; título, descrição e capa só aparecem após a autorização. No desenvolvimento local, a URL da capa acompanha a origem e a porta atuais. Em produção, configure `QUADRICS_APP_URL` com a URL pública canônica para que a capa use o domínio correto.

Ao criar um link, o fotógrafo pode definir um PIN opcional de 6 a 12 dígitos e deve compartilhar o código por outro canal. O banco guarda o PIN com bcrypt; cinco tentativas incorretas bloqueiam por uma hora somente a combinação daquele endereço IP e link, sem interromper o acesso dos demais clientes. O identificador do endereço é um HMAC; o IP bruto não é armazenado. A função que verifica o PIN só pode ser chamada pelo servidor, nunca pela chave pública do navegador. Um PIN correto cria uma sessão aleatória de 256 bits em cookie HttpOnly, limitada ao link e válida por até 12 horas ou até o vencimento do link. Página, imagens, seleção e downloads verificam essa sessão.

Ao criar o link, escolha entre **Cliente escolhe fotos** e **Entrega completa**. O primeiro mantém a seleção revisável e exige autorização manual dos downloads após o envio. O segundo mostra todas as fotos prontas e libera os originais imediatamente, sem etapa de seleção; cada foto continua limitada a três emissões, e o fotógrafo pode desativar downloads ou revogar o link.

Um membro publica a galeria e cria um link válido por 1, 7 ou 14 dias. É necessário ter pelo menos uma foto processada e pronta para criar ou renovar um link; fotos pendentes, com falha ou marcadas para exclusão não contam. A interface explica esse requisito e o banco o aplica também às chamadas de compatibilidade e à renovação. O banco aceita validades entre uma hora e 30 dias. Cada token aleatório de 256 bits aparece **uma única vez** para copiar; no banco fica apenas seu hash SHA-256. Para reenviar o acesso, o fotógrafo pode gerar um novo token: o link anterior é invalidado imediatamente, a validade recomeça pelo prazo escolhido e a seleção, o histórico e as permissões continuam no mesmo compartilhamento. Sessões de PIN antigas são removidas; a proteção existente é mantida e o cliente precisa receber o novo endereço. A tela oferece cópia em um clique e uma mensagem pronta para compartilhar pelo WhatsApp. Se o link tiver PIN, a mensagem avisa que o código deve ser enviado separadamente e nunca inclui o PIN. O Quadrics não o envia automaticamente. A lista de links mostra a data da última renovação e permite revogar, sem revelar tokens anteriores.

O painel do workspace também destaca até 10 links ativos que vencem nos próximos três dias, ordenados pela data mais próxima, com acesso direto à galeria para renovar o link.

Quem recebe o link abre a galeria sem conta e vê uma capa editorial escolhida pelo fotógrafo; se não houver escolha, usa a primeira foto pronta na ordem da galeria. Fotos em processamento, indisponíveis ou com exclusão pendente nunca podem ser capa. A página também mostra o título, a descrição e um atalho para a grade. A galeria mostra somente fotos `ready`, sem exclusão pendente. O visitante recebe miniaturas e previews WebP, não o original JPEG/PNG. O servidor confere o token, a validade, a revogação, o status `published` e a foto em **toda requisição de imagem**. Revogar, expirar, despublicar ou arquivar impede novos acessos. Despublicar revoga os links permanentemente: republicar exige criar outros. Um link inválido, revogado ou vencido exibe a mesma página de acesso indisponível, orientando o cliente a pedir um novo link ao fotógrafo sem revelar o motivo do bloqueio.

A grade consulta e apresenta até 60 fotos por lote; os lotes seguintes são carregados sob demanda. A busca e o filtro por selecionadas consultam o conjunto completo no servidor, sem enviar todos os nomes de arquivo na carga inicial. As requisições de página validam novamente o link e a sessão PIN, quando houver.

O proprietário pode definir nome, cor e logo em **Marca do estúdio**. O nome interno do workspace não é publicado automaticamente; sem uma marca definida, a galeria mantém a identificação Quadrics. O logo aceita PNG, JPEG ou WebP estático de até 2 MiB; o servidor valida a imagem, remove metadados e grava uma versão WebP otimizada em bucket privado. Cada leitura revalida o compartilhamento, o PIN e o limite de solicitações antes de buscar o arquivo; links expirados ou revogados não recebem o logo.

O link é uma credencial portadora: qualquer pessoa com o endereço pode visualizar a galeria até o vencimento ou revogação. Não há autenticação individual do visitante nesta etapa. O navegador não recebe a chave administrativa. As rotas da galeria enviam `Cache-Control: no-store`, `Referrer-Policy: no-referrer` e instrução para buscadores não indexarem.

## Configuração local

Aplicar migrações sem reset:

```sh
npx supabase migration up --local
```

Para servir previews privados a visitantes, configurar `SUPABASE_SERVER_SECRET_KEY` em `.env.local` com a chave **local** retornada por `npx supabase status`. Ela deve existir apenas no servidor, sem prefixo `NEXT_PUBLIC_`; reinicie `npm run dev` após alterar o arquivo. O E2E passa a chave local ao servidor de teste automaticamente. Em ambiente hospedado, usar um segredo próprio do servidor. Uma [chave administrativa no navegador ignora as regras de acesso](https://supabase.com/docs/guides/database/postgres/row-level-security); nunca incluí-la no bundle cliente nem no controle de versão.

Em desenvolvimento, o servidor identifica a origem por `cf-connecting-ip`, `x-real-ip` ou pelo último endereço válido de `x-forwarded-for`. Em produção, `QUADRICS_TRUSTED_CLIENT_IP_HEADER` precisa apontar para um único cabeçalho (`cf-connecting-ip`, `x-real-ip` ou `x-forwarded-for`) que o proxy sobrescreve com o IP real do cliente. O valor deve ser um único IP válido; cabeçalho ausente, inválido ou com uma cadeia de endereços falha de forma fechada. O preflight bloqueia a inicialização de produção quando o cabeçalho confiável não está configurado.

O servidor usa a chave pública para validar o link por funções restritas do banco; usa a chave administrativa separada somente para buscar um derivado depois da validação. A rota pública não aceita o nome de bucket ou caminho do arquivo enviado pelo visitante. O bucket original não pode ser selecionado por esse fluxo.

## Limites antes do piloto

A rota do servidor permite até 1.800 solicitações de miniaturas e previews por minuto para cada combinação de link e origem. Ao ultrapassar o limite, responde HTTP 429 com `Retry-After`. O banco armazena apenas HMAC do IP e remove registros após 24 horas sem atividade. O limite depende de cabeçalhos de IP confiáveis: em produção, configure o proxy para substituir `cf-connecting-ip`, `x-real-ip` ou `x-forwarded-for`. Sem um endereço confiável, o ambiente local continua funcionando; em produção, a rota responde 503 até o proxy fornecer uma origem válida. Ataques distribuídos por vários IPs continuam exigindo proteção no proxy ou provedor.

As operações de escolha, remoção, observação, limpeza e envio têm também um teto de 300 gravações por minuto para cada link, aplicado diretamente pelas funções do banco. O limite vale para todos que compartilham o endereço e também para chamadas RPC diretas; o excesso retorna HTTP 429 e `Retry-After`. O contador não armazena endereço IP e a rotina `gallery-rate-limits` remove estados sem atividade há 24 horas. Essa proteção por link limita abuso concentrado, mas não substitui controles por IP no proxy para ataques distribuídos.

- O desbloqueio limita tentativas por IP e link; ataques distribuídos por vários endereços ainda exigem proteção adicional no proxy ou provedor. Ainda não há medição de transferência nem alertas para acessos anômalos.
- O token permanece no endereço e pode aparecer em histórico ou logs do servidor. Não enviar esse endereço para ferramentas de analytics de terceiros.
- O link não identifica cada visitante. Ele permite uma seleção compartilhada por todos que possuem o endereço no modo de seleção. Nesse modo, downloads dos originais precisam ser liberados pelo fotógrafo após o envio e cobrem somente as fotos escolhidas. No modo de entrega completa, os originais de todas as fotos prontas ficam disponíveis imediatamente; veja [downloads autorizados](10-downloads-autorizados.md).
- A aplicação consulta o Storage a cada imagem; cache compartilhado foi desativado para preservar a revogação. Medir custo e latência antes do piloto.
- A execução remota da CI e testes manuais em dispositivos reais ainda precisam ser observados.

## Testes

O cartão social sem PIN é gerado como JPEG 1200 × 630, usa a capa selecionada pelo fotógrafo e respeita a identidade pública do estúdio, incluindo o logo quando configurado. O E2E confirma as dimensões, o tipo da imagem e a presença do logo, além de verificar que links protegidos não anunciam nem entregam o cartão.

`npm run db:test` inclui testes do hash do PIN, bloqueio após tentativas incorretas, isolamento por cliente e link, permissão exclusiva do servidor e autorização de imagens, seleção e downloads. A suíte do banco também verifica o teto de 300 gravações por link, o período de espera, a retomada após um minuto e a limpeza do estado inativo.

O fluxo público completo também roda em viewports móveis de 390 × 844 e 320 × 844, verificando que a página não ultrapasse a largura da tela. Esse teste automatizado não substitui a validação manual em celulares reais.

`npm run db:test` cobre criação restrita a membros, validade, token em hash, revogação, despublicação e isolamento de fotos entre galerias. `npm run test:e2e` verifica navegação sem login, conteúdo WebP real, ausência de originais, expiração, revogação e arquivamento sobre build de produção.

Validação local mais recente: 76 testes unitários, 392 verificações de banco, lint e TypeScript passaram. O E2E de compartilhamento também passou e cobre a grade progressiva com 67 fotos, busca por uma imagem fora do primeiro lote, além da criação e renovação de links somente quando há fotos prontas, invalidação do endereço anterior, mensagem sem exposição do PIN, pedido de revisão, downloads e notificações pelo Mailpit. A mensagem de revisão protegida por PIN também tem teste unitário. Seleção e downloads estão documentados em [seleção de fotos](09-selecao-fotos.md) e [downloads autorizados](10-downloads-autorizados.md). A execução remota da CI e testes manuais em dispositivos reais permanecem pendentes.
