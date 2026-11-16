@echo off
set "APPDIR=%~dp0"
if "%APPDIR:~-1%"=="\" set "APPDIR=%APPDIR:~0,-1%"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%APPDIR%"
