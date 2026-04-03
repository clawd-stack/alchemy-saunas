@echo off
title Alchemy Bridge Server
cd /d "C:\Users\James\Documents\Claude\Projects\AI Agent Team\alchemy-saunas"
echo Starting bridge server...
start "Alchemy Node Server" /min cmd /c "node server.js"
echo Starting Cloudflare tunnel...
echo.
echo Copy the tunnel URL below into Settings ^> Bridge Server URL
echo.
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3456
