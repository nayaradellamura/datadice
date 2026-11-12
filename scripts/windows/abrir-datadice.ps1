. (Join-Path $PSScriptRoot 'comum.ps1')

try {
    New-Item -ItemType Directory -Force $LogDir | Out-Null
    Remove-Item Env:NoDefaultCurrentDirectoryInExePath -ErrorAction SilentlyContinue
    $port = Get-DataDicePort
    $url = "http://localhost:$port"

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'O Node.js não foi encontrado neste computador.' }

    # Primeiro o banco, depois o jogo, que precisa dele para iniciar.
    Start-DataDiceDatabase

    # Jogo já aberto, mas o código mudou depois que ele iniciou (atualização): reinicia para valer a versão nova.
    # Só mexe no processo do DataDice (identificado pelo caminho do index.js deste projeto).
    $codeChanged = @(Get-ChildItem -Path (Join-Path $ProjectDir 'src') -Recurse -File) + @(Get-Item (Join-Path $ProjectDir 'index.js')) |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    $running = @(Get-DataDiceProcesses | Where-Object { $_.Name -eq 'node.exe' })
    $outdated = @($running | Where-Object { $_.CreationDate -lt $codeChanged.LastWriteTime })
    if ($outdated.Count) {
        foreach ($process in $outdated) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
        $deadline = (Get-Date).AddSeconds(10)
        while ((Test-PortOpen $port) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
    }

    # As imagens agora são geradas pelo Gemini; o Stable Diffusion local não é mais iniciado.
    if (-not (Test-GameRunning $port)) {
        Start-Process $node.Source -ArgumentList "`"$(Join-Path $ProjectDir 'index.js')`"" -WorkingDirectory $ProjectDir -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $LogDir 'datadice.log') -RedirectStandardError (Join-Path $LogDir 'datadice-erros.log')
    }

    $deadline = (Get-Date).AddSeconds(20)
    while (-not (Test-PortOpen $port) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-PortOpen $port)) { throw "O jogo não iniciou. Detalhes em:`n$LogDir" }

    Start-Process $url
} catch {
    Show-Message "Não foi possível abrir o DataDice.`n`n$($_.Exception.Message)" 'Error'
    exit 1
}
