# Cria os atalhos na Área de Trabalho. Pode ser repetido; só substitui os próprios atalhos.
$root = $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$icon = (Resolve-Path (Join-Path $root '..\..\public\img\datadice.ico')).Path
$shell = New-Object -ComObject WScript.Shell

foreach ($item in @(
    @{ Name = 'Abrir DataDice'; Script = 'abrir-datadice.ps1'; Description = 'Abre o jogo e o gerador de imagens' },
    @{ Name = 'Fechar DataDice'; Script = 'fechar-datadice.ps1'; Description = 'Fecha o jogo e libera o notebook' }
)) {
    $shortcut = $shell.CreateShortcut((Join-Path $desktop "$($item.Name).lnk"))
    $shortcut.TargetPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $root $item.Script)`""
    $shortcut.WorkingDirectory = $root
    $shortcut.IconLocation = "$icon,0"
    $shortcut.Description = $item.Description
    $shortcut.WindowStyle = 7
    $shortcut.Save()
    Join-Path $desktop "$($item.Name).lnk"
}
