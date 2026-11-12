param([switch]$Silencioso)

. (Join-Path $PSScriptRoot 'comum.ps1')

$processes = @(Get-DataDiceProcesses)
foreach ($process in $processes) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

# Com o jogo fechado, desliga o banco do DataDice (o que já foi salvo fica guardado).
$databaseWasOn = Test-PortOpen $PgPort
Stop-DataDiceDatabase
$databaseStillOn = Test-PortOpen $PgPort

$remaining = @(Get-DataDiceProcesses)
if (-not $Silencioso) {
    if ($remaining.Count -or $databaseStillOn) {
        Show-Message 'Alguns processos do DataDice não puderam ser fechados. Reinicie o computador se ele continuar lento.' 'Warning'
    } elseif ($processes.Count -or $databaseWasOn) {
        Show-Message 'DataDice fechado. Seu progresso fica salvo.'
    } else {
        Show-Message 'O DataDice já estava fechado.'
    }
}
if ($remaining.Count -or $databaseStillOn) { exit 1 }
