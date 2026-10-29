@echo off
set "DIR=%USERPROFILE%\.dsh\dsh-virus-cat\runtime\electron-helper\assets\audio\sounds"
if not exist "%DIR%" mkdir "%DIR%"
start "" explorer "%DIR%"
