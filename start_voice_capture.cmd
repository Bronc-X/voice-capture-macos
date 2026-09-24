@echo off
setlocal
title Voice Capture Launcher

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_voice_capture.ps1" %*
set "VOICE_CAPTURE_EXIT_CODE=%ERRORLEVEL%"

if not "%VOICE_CAPTURE_EXIT_CODE%"=="0" (
    echo.
    echo Voice capture failed to start. The PowerShell error is shown above.
    echo.
    pause
)

exit /b %VOICE_CAPTURE_EXIT_CODE%
