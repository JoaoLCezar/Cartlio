# Backup e recuperação

## Estado atual

O backup local exporta roles, schema, dados da aplicação, histórico de migrações, dados do Supabase Auth, cópias das migrations e bytes dos quatro buckets privados. `auth-data.sql` exporta Auth separadamente; `data.sql` inclui somente `public`, evitando duplicar Auth e Storage. Os objetos do Storage são copiados pela API, com caminho, tipo MIME e política de cache anotados no manifesto; ao restaurá-los pela API, o Supabase recria seus metadados em `storage.objects`. O formato 4 inclui o bucket de logos; backups completos no formato 3 continuam reconhecidos com os três buckets originais. O comando `backup:restore-check` ensaia a restauração em uma instância descartável com portas e identificador próprios ([backup e restauração pelo CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore), [schema do Storage](https://supabase.com/docs/guides/storage/schema/design), [migração de usuários Auth](https://supabase.com/docs/guides/troubleshooting/migrating-auth-users-between-projects)).

As migrações versionam o schema, não os dados das contas nem os arquivos enviados. O Quadrics usa quatro buckets privados: `gallery-originals`, `gallery-previews`, `gallery-thumbnails` e `gallery-brand-assets`. Os metadados de fotos e logos permanecem ligados a linhas em `storage.objects` e devem corresponder aos objetos restaurados.

## Critérios para considerar a rotina pronta

1. Exportar roles, schema, dados da aplicação, histórico de migrações e dados de Auth para um destino fora do repositório. **Implementado para o Supabase local.**
2. Copiar os quatro buckets completos para o mesmo ponto de recuperação, preservando caminhos dos objetos. **Implementado para o Supabase local.**
3. Registrar arquivos, tamanho e SHA-256 e conferir a estrutura: dumps necessários, Auth, migrations, buckets e metadados de cada objeto. **Implementado no formato 3.**
4. Restaurar o conjunto em uma instância Supabase descartável, sem tocar no banco local de desenvolvimento nem num projeto ativo. **Ensaio automatizado local implementado.**
5. Confirmar que usuários conseguem entrar, membros veem as galerias corretas, previews abrem, seleções permanecem e downloads autorizados continuam funcionando. **Parcial:** `backup:restore-check` confere os vínculos de todas as fotos ativas com seus objetos, verifica os hashes de todos os objetos restaurados e, quando há uma conta com e-mail e fotos existentes, autentica um membro por link temporário para validar acesso ao workspace, à galeria, ao original e aos derivados privados. `backup:restore-e2e` testa pela interface uma conta sintética, upload, processamento, preview, seleção do cliente e download autorizado. As senhas originais das contas preexistentes ainda não são verificadas; o ensaio não conhece as credenciais dos usuários.
6. Medir o tempo da restauração e a idade do backup recuperável; então definir RPO, RTO, retenção, criptografia, acesso e agendamento. **O comando informa duração e idade do backup; os limites operacionais ainda precisam ser definidos.**

O verificador aceita manifests nos formatos 1 e 2 para conferir hashes, mas marca esses conjuntos como incompletos: o formato 1 não inclui Auth e cópias das migrations; o formato 2 não separa com segurança os dados do schema `public` de Auth e Storage. O ensaio aceita apenas o formato 3. Não usar `supabase db reset` ou `supabase stop --no-backup` como tentativa de recuperação do banco de desenvolvimento. A limpeza com `--no-backup` ocorre somente no projeto temporário criado pelo ensaio.

## Escopo desta etapa

O backup não agenda execuções. Ele grava por padrão em `%LOCALAPPDATA%/CartlioBackups`; use `--output` para apontar outro diretório privado fora do repositório. As pastas contêm dados pessoais, hashes de senha e tokens de identidade: restrinja o acesso e proteja uma cópia fora desta máquina antes de depender delas. Na restauração, usuários precisarão entrar novamente; a chave JWT e as sessões não são copiadas para a instância local descartável.

Antes de iniciar, suspenda todos os processos que possam gravar no banco ou no Storage: aplicação, workers, scripts de manutenção e clientes de teste. Os dumps do banco e a cópia do Storage são feitos em sequência, não formam um snapshot atômico. A verificação confere hashes e a estrutura do arquivo, mas não comprova que Postgres, Auth e buckets podem ser restaurados juntos.

```sh
npm run backup:local -- --dry-run
npm run backup:local -- --output "D:\CartlioBackups"
npm run backup:verify -- "D:\CartlioBackups\cartlio-AAAA-MM-DD..."
npm run backup:restore-check -- --backup "D:\CartlioBackups\cartlio-AAAA-MM-DD..."
npm run backup:restore-e2e -- --backup "D:\CartlioBackups\cartlio-AAAA-MM-DD..."
```

Também é possível criar um arquivo `.cartlio.enc` com `--encrypt`. O formato usa AES-256-GCM com chave derivada por scrypt. O manifesto, nomes e conteúdo dos arquivos ficam cifrados; os tamanhos dos arquivos e a quantidade de registros ainda podem ser inferidos pelo tamanho do arquivo.

A criptografia é opcional para manter compatibilidade. Defina `QUADRICS_BACKUP_PASSPHRASE` somente no processo que executa os comandos; são necessários pelo menos 16 bytes UTF-8. Guarde a frase secreta em um gerenciador de senhas separado do backup. Perdê-la torna esse arquivo irrecuperável. Não a grave em `.env.local`, no repositório ou junto ao arquivo cifrado.

No PowerShell, o exemplo abaixo solicita a frase sem exibi-la no terminal e a remove do ambiente ao terminar:

```powershell
$securePhrase = Read-Host "Frase secreta do backup" -AsSecureString
$phrasePointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePhrase)
try {
  $env:QUADRICS_BACKUP_PASSPHRASE = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($phrasePointer)
  npm run backup:local -- --encrypt
  npm run backup:verify -- "$env:LOCALAPPDATA\CartlioBackups\cartlio-AAAA-MM-DD...cartlio.enc"
  npm run backup:restore-check -- --backup "$env:LOCALAPPDATA\CartlioBackups\cartlio-AAAA-MM-DD...cartlio.enc"
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($phrasePointer)
  Remove-Item Env:QUADRICS_BACKUP_PASSPHRASE -ErrorAction SilentlyContinue
  $securePhrase.Dispose()
}
```

O arquivo cifrado é decifrado em uma pasta temporária privada para verificação ou ensaio de restauração, e essa pasta é removida ao final. Se a cifra falhar, o backup original em claro permanece para evitar perda de dados; proteja-o e tente novamente. A rotina continua sem agendamento e ainda requer uma cópia protegida fora desta máquina.

O comando E2E requer Docker Desktop ativo e executa apenas sobre o Supabase descartável criado para o ensaio. Ele inicia um servidor Next temporário com build isolado e remove a conta sintética, os containers e os arquivos temporários ao terminar. Agendamento e cópias fora da máquina ficam para quando o ambiente de operação for definido.
