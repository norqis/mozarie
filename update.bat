@echo off
chcp 65001 >nul
setlocal
set "APP_DIR=%~dp0"
if defined MOZARIE_PYTHON (set "PYTHON=%MOZARIE_PYTHON%") else set "PYTHON=%APP_DIR%.venv\Scripts\python.exe"
if not exist "%PYTHON%" goto :missing_python
call :validate_python
if errorlevel 1 goto :invalid_mozarie_python

(
 "%PYTHON%" -X utf8 "%~dp0updater.py" &rem rem
 goto :finish_update
)

:finish_update
rem Keep the launch block layout: older CMD readers resume inside its rem.
set "EXIT_CODE=%ERRORLEVEL%"
goto :finish

:invalid_mozarie_python
echo [Mozarie] MOZARIE_PYTHON is invalid. / MOZARIE_PYTHON が正しくありません。
set "EXIT_CODE=1"
goto :finish

:missing_python
echo [Mozarie] Python 3.11 or newer was not found. Run setup.bat, or set MOZARIE_PYTHON. / Python 3.11 以上が見つかりません。setup.batを実行するかMOZARIE_PYTHONを設定してください。
set "EXIT_CODE=1"

:finish
pause
exit /b %EXIT_CODE%

:validate_python
"%PYTHON%" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
exit /b %ERRORLEVEL%
