Write-Host "DarkPlanner - Limpando portas e iniciando..." -ForegroundColor Cyan
powershell -ExecutionPolicy Bypass -File .\FECHAR_PORTAS.ps1
npm run dev
pause
