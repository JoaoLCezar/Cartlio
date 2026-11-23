# Seleção de fotos pelo cliente

Este é um dos modos de compartilhamento. Para entregar todas as fotos sem pedir escolhas, crie o link **Entrega completa**; nesse modo, não há seleção nem envio pelo cliente e os originais ficam disponíveis conforme [downloads autorizados](10-downloads-autorizados.md).

Ao criar um link, o fotógrafo pode definir o máximo de escolhas: 1, 5, 10, 20, 50, 100 ou 500 fotos. O cliente vê o limite e a interface desativa escolhas adicionais; a função de banco também aplica o limite. Links anteriores mantêm o padrão de 500 fotos.

## Fluxo

No visualizador em telas sensíveis ao toque, deslizar para a esquerda avança e para a direita volta à foto anterior. Gestos verticais não trocam a imagem; setas visíveis, teclado e `Esc` continuam disponíveis.

Em galerias longas, o cliente também pode buscar pelo nome original do arquivo. A busca não diferencia maiúsculas, minúsculas ou acentos e pode ser combinada com o filtro de fotos selecionadas.

Depois da primeira escolha, um atalho fixo acompanha o cliente pela galeria e leva diretamente ao formulário de envio, sem substituir a revisão e a confirmação existentes.

Depois do envio, o fotógrafo pode baixar a seleção atual em CSV com nomes originais e identificadores das fotos. O arquivo abre em planilhas com separador brasileiro e mantém os nomes de arquivo como texto seguro.

Antes de enviar, o cliente pode alternar entre todas as fotos e somente as escolhidas para revisar rapidamente a seleção, inclusive depois do envio.

O fotógrafo publica uma galeria com fotos processadas e cria um link temporário. Quem recebe o link escolhe entre os previews prontos. Ao abrir uma foto, um visualizador em tela cheia permite avançar e voltar com as setas do teclado, fechar com `Esc` e marcar a escolha sem sair da galeria. Cada escolha ou remoção é gravada imediatamente; ao reabrir o mesmo link, o rascunho reaparece. O contador mostra quantas fotos estão escolhidas. Para concluir, o cliente informa um nome, confirma o envio e recebe a indicação de que a seleção foi enviada. O fotógrafo vê o nome, a data e os nomes dos arquivos escolhidos na página da galeria. O painel destaca até 10 seleções recebidas ainda não conferidas, da mais antiga à mais nova, com contagem de fotos e atalho direto para conferência; todas continuam acessíveis na lista de galerias. Na galeria, o fotógrafo pode marcar a seleção como conferida ou devolvê-la às pendências. Se solicitar ajustes, a nova versão enviada pelo cliente retorna automaticamente à fila.

O envio exige ao menos uma foto disponível. Depois dele, a seleção fica fechada para edição pelo cliente, mesmo se a página for recarregada. O workspace recebe um aviso por e-mail quando o cliente envia a seleção. Se precisar de mudanças, o fotógrafo pode solicitar ajustes com uma orientação visível pelo mesmo link; quando a galeria está vinculada a um cliente com e-mail cadastrado, o sistema enfileira um aviso com essa orientação. Uma fila transacional preserva os eventos enquanto o SMTP estiver indisponível e tenta novamente até cinco vezes. Avisos concluídos são retidos por 90 dias. No ambiente local, `npm run dev` mantém o worker ativo e as mensagens ficam no Mailpit em `http://localhost:54324`; também é possível executar uma vez com `npm run notifications:deliver -- --local`. Para processar somente os avisos de um compartilhamento específico, passe `--share UUID` com o ID interno do compartilhamento, não o token público. Em produção, configure SMTP e execute `npm run notifications:deliver -- --remote` por um agendador ou worker persistente. O e-mail de revisão não contém o link portador nem o PIN: orienta o cliente a abrir o endereço que já recebeu. O painel também prepara uma mensagem de WhatsApp com a orientação, para o fotógrafo revisar e enviar por outro canal.

Na tela da galeria, o fotógrafo acompanha o estado do aviso da seleção atual: na fila, em processamento, aguardando nova tentativa, aceito pelo serviço de e-mail ou com falha após cinco tentativas. O painel não expõe endereço do destinatário nem detalhes técnicos do SMTP; esses estados só podem ser consultados por membros do workspace.

Se o aviso falhar após cinco tentativas automáticas, um membro pode colocá-lo novamente na fila até duas vezes. O sistema busca o e-mail atual do fotógrafo ou do cliente no cadastro e só reenvia um evento que ainda corresponde ao estado atual da seleção; pedidos de ajustes vencidos ou links revogados não podem ser reenviados ao cliente. Depois do segundo limite manual, use outro canal ou corrija a configuração de e-mail antes de prosseguir.

A versão enviada e os nomes originais dos arquivos ficam no histórico; as escolhas ainda disponíveis permanecem como ponto de partida. Ao reabrir a seleção, os downloads são suspensos. Depois do novo envio, o fotógrafo pode liberá-los novamente. Chamadas repetidas de envio mantêm o primeiro registro de cada versão. Na confirmação, escolhas de fotos que deixaram de estar prontas são descartadas; se nenhuma escolha válida restar, o envio não ocorre.

## Acesso e limites

O rascunho pertence ao **compartilhamento**, não a uma conta individual. Pessoas com o mesmo endereço podem ver e alterar o mesmo rascunho até o envio; para seleções independentes, crie links diferentes. Se o cliente perder o endereço, o fotógrafo pode gerar um novo token para o mesmo compartilhamento: o link antigo deixa de funcionar, mas seleção, histórico e downloads autorizados permanecem vinculados ao novo endereço. Revogação, vencimento, despublicação e arquivamento impedem novos acessos, inclusive alterações de escolhas. O token fica em hash no banco. Funções do banco verificam o token, a galeria, o estado de cada foto e o limite de 500 escolhas; escritas diretas na tabela de seleções são negadas aos visitantes e membros.

O nome informado não comprova a identidade do cliente. O aviso por e-mail depende de um endereço válido no cadastro do cliente ou do proprietário do workspace e da disponibilidade do worker SMTP. Sem endereço do cliente, o painel informa que o aviso precisa ser enviado por outro canal e prepara a mensagem de WhatsApp. O fotógrafo pode autorizar a entrega dos originais escolhidos conforme [downloads autorizados](10-downloads-autorizados.md). Antes do piloto, validar a experiência em celulares reais, configurar SMTP de produção e acrescentar proteção contra abuso aos links públicos.

## Operação e validação

Aplicar a migração incremental sem apagar dados:

```sh
npx supabase migration up --local
```

`npm run db:test` verifica isolamento, fotos elegíveis, rascunho, envio idempotente, bloqueio de edição, solicitação de ajustes, histórico da versão anterior, pausa de downloads, entrada e reabertura da fila do painel e estados seguros do e-mail (fila, envio, nova tentativa, sucesso e falha final), sem liberar endereços aos membros. `npm test` cobre templates de e-mail, SMTP, falhas e tentativas sem expor respostas do provedor. `npm run test:e2e -- tests/e2e/gallery-sharing.spec.ts` percorre a seleção, o atalho da fila no painel, a conclusão da conferência, o retorno de uma versão revisada para a fila, a renovação do link com invalidação do endereço antigo, a mensagem pronta no WhatsApp e os downloads num build de produção. Um teste unitário verifica a mensagem de revisão por WhatsApp para links com PIN sem incluir o código. A execução remota da CI e testes manuais em aparelhos reais ainda não foram observados.

O cenário E2E de compartilhamento também valida o visualizador, a navegação por teclado, o atalho fixo para envio e o layout estreito até 320 px. A última execução local passou no Edge.

## Observações por foto

Em links no modo de seleção, o cliente pode adicionar uma observação de até 500 caracteres a cada foto escolhida antes de enviar ou durante uma revisão solicitada pelo fotógrafo. A observação é opcional, pode ser apagada enquanto a seleção estiver aberta e fica bloqueada após o envio. Links de entrega completa não oferecem esse campo.

O fotógrafo vê as observações junto aos nomes das fotos enviadas, no histórico das versões anteriores e no arquivo CSV da seleção. As observações ficam associadas ao link, respeitam o PIN e os mesmos estados de expiração, revogação e publicação da galeria.

## Limpar a seleção

Enquanto o rascunho estiver aberto, o cliente pode limpar todas as fotos escolhidas de uma vez. A confirmação informa que as observações também serão removidas. A ação exige um link ativo e, quando configurado, uma sessão de PIN válida; o banco remove as escolhas como uma operação atômica. Links de entrega completa e seleções já enviadas não aceitam a limpeza. O histórico de versões enviadas permanece preservado.


Os testes automatizados verificam a limpeza sem PIN, com sessão válida, para links de entrega e após o envio. O E2E confirma a limpeza da interface, a remoção das observações e o início de uma nova seleção.
