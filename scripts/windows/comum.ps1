# Funções usadas pelos atalhos do DataDice. Não guarda chaves nem lê outros valores do .env.
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$WebUiDir = 'E:\stable-diffusion-webui'
$LogDir = Join-Path $ProjectDir 'data\logs'
$WebUiPort = 7860

# PostgreSQL só do DataDice, na conta do usuário (criado sem administrador). Escuta só em 127.0.0.1:5433.
$PgBin = 'C:\Program Files\PostgreSQL\17\bin'
$PgData = Join-Path $env:LOCALAPPDATA 'DataDice\postgres'
$PgLog = Join-Path $env:LOCALAPPDATA 'DataDice\postgres.log'
$PgPort = 5433

function Start-DataDiceDatabase {
    # Sem o banco local (por exemplo, usando um banco na internet), não há nada para ligar.
    if (-not (Test-Path (Join-Path $PgData 'PG_VERSION'))) { return }
    if (Test-PortOpen $PgPort) { return }
    # Sem redirecionar a saída: o servidor herda o console do pg_ctl e o PowerShell ficaria esperando.
    Start-Process -FilePath (Join-Path $PgBin 'pg_ctl.exe') -ArgumentList @('-D', "`"$PgData`"", '-l', "`"$PgLog`"", 'start') -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-PortOpen $PgPort) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-PortOpen $PgPort)) { throw "O banco de dados não iniciou. Detalhes em:`n$PgLog" }
}

function Stop-DataDiceDatabase {
    if (-not (Test-PortOpen $PgPort)) { return }
    # Desliga só o banco do DataDice (pela pasta dele), esperando gravar tudo antes.
    Start-Process -FilePath (Join-Path $PgBin 'pg_ctl.exe') -ArgumentList @('-D', "`"$PgData`"", 'stop', '-m', 'fast', '-w') -WindowStyle Hidden -Wait
}

function Get-DataDicePort {
    $envFile = Join-Path $ProjectDir '.env'
    if (Test-Path $envFile) {
        $line = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)\s*$' | Select-Object -First 1
        if ($line) { return [int]$line.Matches[0].Groups[1].Value }
    }
    return 3000
}

function Test-PortOpen([int]$Port) {
    # Tenta conectar de verdade: o Get-NetTCPConnection pode responder vazio mesmo com o serviço no ar.
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $attempt = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        return ($attempt.AsyncWaitHandle.WaitOne(800) -and $client.Connected)
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Show-Message([string]$Text, [string]$Kind = 'Information') {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($Text, 'DataDice', 'OK', $Kind)
}

function Test-WebUiRunning {
    # Conta também o WebUI ainda carregando, que não responde na porta, para não abrir um segundo.
    return (Test-PortOpen $WebUiPort) -or [bool](@(Get-DataDiceProcesses | Where-Object { $_.Name -ne 'node.exe' }).Count)
}

function Test-GameRunning([int]$Port) {
    return (Test-PortOpen $Port) -or [bool](@(Get-DataDiceProcesses | Where-Object { $_.Name -eq 'node.exe' }).Count)
}

# Só devolve processos identificados pelo caminho do projeto ou do WebUI.
function Get-DataDiceProcesses {
    $projectScript = Join-Path $ProjectDir 'index.js'
    Get-CimInstance Win32_Process | Where-Object {
        $line = $_.CommandLine
        if (-not $line) { return $false }
        ($_.Name -eq 'node.exe' -and $line.Contains($projectScript)) -or
        ($_.Name -eq 'python.exe' -and $line -like "*$WebUiDir*") -or
        ($_.Name -eq 'python.exe' -and $_.ExecutablePath -like "$WebUiDir\*") -or
        ($_.Name -eq 'cmd.exe' -and $line -like '*webui-user.bat*')
    }
}
