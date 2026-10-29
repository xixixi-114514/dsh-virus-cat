@echo off
rem start virus-cat. paths are built inside powershell so the chinese
rem username never goes through cmd's ansi conversion (avoids mojibake).
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -match 'dsh-virus-cat' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
powershell -NoProfile -WindowStyle Hidden -Command "$env:ELECTRON_RUN_AS_NODE=''; $env:DSH_VC_STANDALONE='1'; $env:DSH_VC_RECBG=''; $env:DSH_VC_LOG=(Join-Path $env:USERPROFILE '.dsh\dsh-virus-cat\helper.log'); $exe=(Join-Path $env:USERPROFILE '.dsh\electron\electron.exe'); $app=(Join-Path $env:USERPROFILE '.dsh\dsh-virus-cat\runtime\electron-helper'); Start-Process -FilePath $exe -ArgumentList $app"
