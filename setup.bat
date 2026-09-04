@echo off
chcp 65001 >nul
setlocal
set "APP_DIR=%~dp0"
if /i "%~1"=="--locked" goto :locked
for %%V in (3.14-64 3.13-64 3.12-64 3.11-64) do (
  py -%%V -c "import sys; raise SystemExit(0)" >nul 2>nul
  if not errorlevel 1 (
    py -%%V -X utf8 "%APP_DIR%updater.py" --check-running
    if errorlevel 31 goto :running_check_failed
    if errorlevel 30 goto :mozarie_running
    py -%%V -X utf8 "%APP_DIR%updater.py" --run-setup-locked
    if errorlevel 1 goto :setup_locked_failed
    exit /b 0
  )
)
echo [Mozarie] 64-bit Python 3.11 to 3.14 was not found. Install it, then run setup.bat again. / 64-bit Python 3.11〜3.14 をインストールしてから setup.bat を実行してください。
exit /b 1

:locked
set "PYTHON=%APP_DIR%.venv\Scripts\python.exe"
set "RUNTIME=%MOZARIE_RUNTIME%"
if not defined RUNTIME if exist "%APP_DIR%.venv\.mozarie-runtime.json" for /f "usebackq delims=" %%R in (`powershell.exe -NoProfile -Command "try { (Get-Content -Raw -LiteralPath '%APP_DIR%.venv\.mozarie-runtime.json' | ConvertFrom-Json).profile } catch { exit 1 }"`) do set "RUNTIME=%%R"
if not defined RUNTIME for /f "usebackq delims=" %%R in (`powershell.exe -NoProfile -Command "$gpu=@(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.PNPDeviceID -like 'PCI*' }); if ($gpu.PNPDeviceID -match 'VEN_10DE') { 'cuda' } elseif ($gpu.PNPDeviceID -match 'VEN_1002') { 'directml' } else { 'cpu' }"`) do set "RUNTIME=%%R"
if /i "%RUNTIME%"=="cuda" goto :runtime_ready
if /i "%RUNTIME%"=="directml" goto :runtime_ready
if /i "%RUNTIME%"=="cpu" goto :runtime_ready
goto :invalid_runtime

:runtime_ready
echo [Mozarie] [1/5] Checking Python environment...
if not exist "%PYTHON%" call :create_venv
if errorlevel 1 goto :venv_failed
if not exist "%PYTHON%" goto :venv_failed
call :validate_python
if errorlevel 1 goto :python_too_old
pushd "%APP_DIR%"
"%PYTHON%" -m mozarie.runtime_profile preflight "%RUNTIME%" --venv "%APP_DIR%.venv"
set "RUNTIME_CHECK=%ERRORLEVEL%"
popd
if not "%RUNTIME_CHECK%"=="0" goto :runtime_mismatch

echo [Mozarie] [2/5] Preparing the installer...
"%PYTHON%" -m pip install --disable-pip-version-check --no-cache-dir --progress-bar on --upgrade pip
if errorlevel 1 goto :pip_upgrade_failed
echo [Mozarie] [3/5] Installing required packages. This may download several GB on the first run.
if exist "%APP_DIR%.venv\.mozarie-ready" del /q "%APP_DIR%.venv\.mozarie-ready"
if exist "%APP_DIR%.venv\.mozarie-ready" goto :ready_marker_remove_failed
echo [Mozarie] Runtime: %RUNTIME%
set "REQUIREMENTS=%APP_DIR%requirements.txt"
if /i "%RUNTIME%"=="directml" set "REQUIREMENTS=%APP_DIR%mozarie\requirements-directml.txt"
if /i "%RUNTIME%"=="cpu" set "REQUIREMENTS=%APP_DIR%mozarie\requirements-cpu.txt"
"%PYTHON%" -m pip install --disable-pip-version-check --progress-bar on -r "%REQUIREMENTS%"
if errorlevel 1 goto :requirements_failed
echo [Mozarie] [4/5] Checking installed packages...
"%PYTHON%" -m pip check
if errorlevel 1 goto :pip_check_failed
echo [Mozarie] [5/5] Checking runtime support...
pushd "%APP_DIR%"
"%PYTHON%" -m mozarie.runtime_profile validate "%RUNTIME%" --venv "%APP_DIR%.venv" --write-marker
set "RUNTIME_CHECK=%ERRORLEVEL%"
popd
if not "%RUNTIME_CHECK%"=="0" goto :runtime_validation_failed
"%PYTHON%" -X utf8 "%APP_DIR%setup_gpu_check.py"
if errorlevel 1 goto :gpu_check_failed
:setup_ready
>"%APP_DIR%.venv\.mozarie-ready" echo ready
if errorlevel 1 goto :ready_marker_create_failed
if not exist "%APP_DIR%.venv\.mozarie-ready" goto :ready_marker_create_failed
echo [Mozarie] Setup complete. Run run.bat.
pause
exit /b 0

:setup_locked_failed
exit /b 1

:create_venv
if /i "%RUNTIME%"=="directml" goto :create_directml_venv
if /i "%RUNTIME%"=="cpu" goto :create_directml_venv
for %%V in (3.14-64 3.13-64 3.12-64 3.11-64) do (
  py -%%V -m venv "%APP_DIR%.venv"
  if not errorlevel 1 goto :venv_ready
)
exit /b 1

:create_directml_venv
for %%V in (3.12-64 3.11-64) do (
  py -%%V -m venv "%APP_DIR%.venv" >nul 2>nul
  if not errorlevel 1 goto :venv_ready
)
exit /b 1

:venv_ready
if not exist "%PYTHON%" exit /b 1
exit /b 0

:validate_python
if /i "%RUNTIME%"=="cuda" "%PYTHON%" -c "import struct, sys; raise SystemExit(0 if (3, 11) <= sys.version_info < (3, 15) and struct.calcsize('P') == 8 else 1)" >nul 2>nul
if /i not "%RUNTIME%"=="cuda" "%PYTHON%" -c "import struct, sys; raise SystemExit(0 if (3, 11) <= sys.version_info < (3, 13) and struct.calcsize('P') == 8 else 1)" >nul 2>nul
exit /b %ERRORLEVEL%

:pip_upgrade_failed
echo [Mozarie] pip could not be updated. Check the message above, then run setup.bat again. / pipを更新できませんでした。上のメッセージを確認してから setup.bat を再実行してください。
pause
exit /b 1

:requirements_failed
echo [Mozarie] Required packages could not be installed. Check the message above, then run setup.bat again. / 必要なパッケージをインストールできませんでした。上のメッセージを確認してから setup.bat を再実行してください。
pause
exit /b 1

:pip_check_failed
echo [Mozarie] Installed packages are inconsistent. Check the message above, then run setup.bat again. / インストール済みパッケージの整合性を確認できませんでした。上のメッセージを確認してから setup.bat を再実行してください。
pause
exit /b 1

:runtime_validation_failed
echo [Mozarie] The selected runtime could not be verified. Check the message above, then run setup.bat again. / 選択した実行環境を確認できませんでした。上のメッセージを確認してから setup.bat を再実行してください。
pause
exit /b 1

:gpu_check_failed
echo [Mozarie] GPU or runtime verification failed. Check the message above, then run setup.bat again. / GPUまたは実行環境の確認に失敗しました。上のメッセージを確認してから setup.bat を再実行してください。
pause
exit /b 1

:ready_marker_remove_failed
echo [Mozarie] Setup could not clear its ready marker. Check folder access, then run setup.bat again. / セットアップ完了マーカーを削除できませんでした。フォルダへのアクセスを確認してから setup.bat を再実行してください。
pause
exit /b 1

:ready_marker_create_failed
echo [Mozarie] Setup could not record completion. Check folder access, then run setup.bat again. / セットアップ完了を記録できませんでした。フォルダへのアクセスを確認してから setup.bat を再実行してください。
pause
exit /b 1

:mozarie_running
echo [Mozarie] Close Mozarie, then run setup.bat again. / Mozarieを終了してから、もう一度 setup.bat を実行してください。
pause
exit /b 1

:running_check_failed
echo [Mozarie] Mozarie status could not be checked. Check the message above, then run setup.bat again. / Mozarieの起動状態を確認できませんでした。上のメッセージを確認してから setup.bat を再実行してください。
pause
exit /b 1

:missing_python
echo [Mozarie] 64-bit Python 3.11 to 3.14 was not found. Install it, then run setup.bat again.
pause
exit /b 1

:venv_failed
echo [Mozarie] Could not create the Python environment. Check the message above, free disk space or folder access, then run setup.bat again. / Python環境を作成できませんでした。上のメッセージを確認し、空き容量またはフォルダへのアクセスを確認してから setup.bat を再実行してください。
pause
exit /b 1

:python_too_old
if /i "%RUNTIME%"=="cuda" echo [Mozarie] CUDA needs 64-bit Python 3.11 to 3.14. Remove .venv and run setup.bat again.
if /i not "%RUNTIME%"=="cuda" echo [Mozarie] DirectML and CPU need 64-bit Python 3.11 or 3.12. Remove .venv and run setup.bat again.
pause
exit /b 1

:invalid_runtime
echo [Mozarie] MOZARIE_RUNTIME must be cuda, directml, or cpu.
pause
exit /b 1

:runtime_mismatch
echo [Mozarie] The existing .venv uses another or inconsistent runtime. It was not modified.
echo [Mozarie] Back up or remove .venv, then run setup.bat again.
pause
exit /b 1
