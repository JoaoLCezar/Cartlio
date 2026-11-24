# Downloads autorizados

O comportamento depende do modo do link. Em **Cliente escolhe fotos**, o fotógrafo libera os originais escolhidos depois do envio. Em **Entrega completa**, todos os originais prontos já ficam disponíveis no momento da criação do link, e o fotógrafo pode desativar essa permissão a qualquer momento.

## Como liberar e usar

Downloads dos originais começam desativados em cada link. Depois que o cliente envia a seleção, o fotógrafo pode liberar ou desativar a permissão na página da galeria. O cliente vê o botão de download apenas nas fotos escolhidas. O acesso não se aplica a outras fotos da galeria.

Ao pedir um arquivo, o servidor confere novamente o token, a validade e revogação do link, o estado publicado da galeria, a permissão de download, o envio da seleção, a foto escolhida e sua disponibilidade. Só então registra a emissão e cria uma URL assinada do Storage válida por 60 segundos. O navegador segue essa URL para receber o original.

Cada foto permite até três emissões de download por link. O fotógrafo vê a contagem no painel. O limite impede pedidos adicionais quando é atingido. As emissões são serializadas por link no banco para evitar que solicitações simultâneas ultrapassem o teto. O botão **Baixar pacote ZIP** reúne os originais permitidos: a seleção enviada no modo Cliente escolhe fotos ou todas as fotos prontas no modo Entrega completa. Cada arquivo do pacote conta como uma emissão.

## Alcance e limites

O painel lê contagens agregadas por link e foto, em vez de transferir cada evento individual. Para links de seleção, só são retornadas contagens das fotos da seleção atual; links de entrega completa mostram o total por foto.

O histórico registra autorizações de download, não confirma que o navegador salvou o arquivo. Desativar o acesso ou revogar o link impede novas URLs; uma URL assinada já emitida pode funcionar até completar seus 60 segundos. Quem receber essa URL pode usá-la durante esse intervalo. O link original continua sendo uma credencial portadora e não identifica cada pessoa.

O ZIP é transmitido em fluxo, sem compactação, com limite de 500 MiB e 500 fotos por pacote. Se a conexão cair ou um arquivo do Storage falhar, o pacote ficará incompleto e será necessário tentar novamente. As fotos completas que já foram transmitidas continuam contando; as fotos seguintes têm suas emissões revertidas para permitir a nova tentativa. O histórico preserva essas tentativas interrompidas. Pacotes acima dos limites devem ser baixados foto a foto.

Os registros de emissão são mantidos por 90 dias por padrão e podem ser configurados entre 30 e 365 dias. A limpeza remove os eventos antigos, e a exclusão do link ou galeria também os remove em cascata. O prazo de 90 dias é uma escolha inicial para desenvolvimento e deve ser revisto antes do piloto. Não há notificação de download nesta etapa.

## Operação e validação

Aplicar a migração incremental sem reset:

```sh
npx supabase migration up --local
```

O navegador público não pode chamar a função de autorização nem ler ou gravar os registros diretamente. A chave de servidor só assina o caminho original depois da validação privilegiada do banco.

Executar a limpeza local com o prazo padrão de 90 dias:

```sh
npm run downloads:prune
```

Para outro prazo dentro do intervalo permitido, por exemplo 180 dias:

```sh
npm run downloads:prune -- --retention-days 180
```

O comando é idempotente e imprime quantos eventos removeu. Num runner externo, configure `SUPABASE_URL` e `SUPABASE_SERVER_SECRET_KEY` como segredos do ambiente e execute `npm run downloads:prune:remote`. O modo remoto exige HTTPS e não chama o CLI local. Em produção, agende o comando e registre o resultado; a agenda depende do ambiente de implantação.

`npm run db:test` cobre permissão inicial desativada, isolamento entre workspaces, autorização exclusiva do servidor, ZIP para os dois modos de compartilhamento, contagem de emissões, limite e retenção. `npm run test:e2e -- tests/e2e/gallery-sharing.spec.ts` verifica a autorização no painel, downloads individuais, pacote ZIP, limite e revogação. Nesta etapa passaram 282 verificações de banco, 56 testes unitários e o fluxo E2E de compartilhamento; lint e TypeScript também passaram. A execução remota da CI e a experiência em celulares reais continuam pendentes.

Em 2026-10-30, a migration `20261215000100_reconcile_interrupted_gallery_bundles.sql` passou na suíte de banco local: emissões de fotos ainda não concluídas são revertidas de forma idempotente, e o histórico mantém o resultado da tentativa. Passaram 558 verificações SQL, 131 testes unitários, lint e TypeScript. O E2E alcançou e validou os downloads ZIP, mas não terminou: a etapa posterior de SMTP esperava saída 1 do worker e recebeu 0; isolar a fila local antes de repetir esse cenário.
