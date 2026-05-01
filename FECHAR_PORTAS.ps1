Write-Host "Fechando processos nas portas 3017, 5173 e 5174..." -ForegroundColor Yellow
$ports = @(3017, 5173, 5174)
foreach ($port in $ports) {
  $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
  foreach ($conn in $connections) {
    $pidToKill = $conn.OwningProcess
    if ($pidToKill -and $pidToKill -ne 0) {
      try { Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue; Write-Host "Porta $port liberada: $pidToKill" -ForegroundColor Green } catch {}
    }
  }
}
Write-Host "Pronto. Agora rode npm run dev" -ForegroundColor Cyan
