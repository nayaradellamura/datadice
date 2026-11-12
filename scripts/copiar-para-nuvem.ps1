# Copia o banco do DataDice deste computador para o banco na nuvem (Neon), uma vez só.
#
# Antes: no .env, coloque a URL do Neon em CLOUD_DATABASE_URL (a conexão DIRETA, sem "-pooler" no
# endereço, terminando com ?sslmode=require). Depois rode, na pasta do projeto:
#   powershell -ExecutionPolicy Bypass -File scripts\copiar-para-nuvem.ps1
#
# Segurança: nenhuma URL ou senha aparece na tela; o banco da nuvem precisa estar vazio (o script recusa
# copiar por cima de dados); o arquivo temporário da cópia é apagado no fim.
# Os programas do PostgreSQL avisam erros pelo código de saída (conferido em cada passo).
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'windows\comum.ps1')

function Read-EnvValue([string]$Name) {
  # Uma variável de ambiente com o mesmo nome tem prioridade (útil para testar sem mexer no .env).
  $fromEnv = [Environment]::GetEnvironmentVariable($Name)
  if ($fromEnv) { return $fromEnv }
  $line = Get-Content (Join-Path $ProjectDir '.env') | Where-Object { $_ -match "^\s*$Name\s*=" } | Select-Object -First 1
  if (-not $line) { return '' }
  return ($line -replace "^\s*$Name\s*=\s*", '').Trim().Trim('"').Trim("'")
}

$source = Read-EnvValue 'DATABASE_URL'
$target = Read-EnvValue 'CLOUD_DATABASE_URL'
if (-not $source) { throw 'DATABASE_URL (banco deste computador) não está no .env.' }
if (-not $target) { throw 'Coloque a URL do Neon em CLOUD_DATABASE_URL no .env antes de rodar.' }
if ($target -eq $source) { throw 'CLOUD_DATABASE_URL é igual ao DATABASE_URL: precisa ser o banco da nuvem.' }
if ($target -match '-pooler') { throw 'Use a conexão DIRETA do Neon (sem "-pooler" no endereço). No painel do Neon, desligue "Connection pooling" ao copiar a URL.' }

$dump = Join-Path $env:TEMP "datadice-copia-$([guid]::NewGuid().ToString('N')).dump"
try {
  Start-DataDiceDatabase
  $psql = Join-Path $PgBin 'psql.exe'

  # O banco da nuvem precisa estar vazio: nunca sobrescreve dados.
  $tables = & $psql --dbname $target -At -c "select count(*) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'"
  if ($LASTEXITCODE -ne 0) { throw 'Não consegui conectar no banco da nuvem. Confira a CLOUD_DATABASE_URL (com ?sslmode=require).' }
  if ([int]$tables -gt 0) { throw "O banco da nuvem já tem $tables tabela(s). Por segurança, a cópia só é feita num banco vazio." }

  Write-Host 'Copiando o banco deste computador...'
  & (Join-Path $PgBin 'pg_dump.exe') --dbname $source --format=custom --no-owner --no-acl --file $dump
  if ($LASTEXITCODE -ne 0) { throw 'Falhou ao ler o banco deste computador.' }

  Write-Host 'Enviando para a nuvem...'
  & (Join-Path $PgBin 'pg_restore.exe') --dbname $target --no-owner --no-acl --exit-on-error $dump
  if ($LASTEXITCODE -ne 0) { throw 'Falhou ao gravar no banco da nuvem. Nada foi apagado deste computador.' }

  # Conferência: mesmas contagens nos dois lados.
  $check = "select (select count(*) from users) || ' contas, ' || (select count(*) from characters) || ' fichas, ' || (select count(*) from campaigns) || ' campanhas e mesas, ' || (select count(*) from messages) || ' mensagens, ' || (select count(*) from images) || ' imagens, ' || (select count(*) from rule_chunks) || ' trechos de regras'"
  $here = & $psql --dbname $source -At -c $check
  $there = & $psql --dbname $target -At -c $check
  Write-Host "Neste computador: $here"
  Write-Host "Na nuvem:         $there"
  if ($here -ne $there) { throw 'As contagens não batem. Me avise antes de usar o banco da nuvem.' }
  Write-Host 'Cópia concluída e conferida.'
} finally {
  if (Test-Path $dump) { Remove-Item $dump -Force }
}
