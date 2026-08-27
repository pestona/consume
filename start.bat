@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js не найден. Установите его с https://nodejs.org и снова запустите этот файл.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Устанавливаю зависимости...
  call npm install
  if errorlevel 1 (
    echo Не удалось установить зависимости.
    pause
    exit /b 1
  )
)

if not exist ".env" (
  echo Файл .env не найден. Скопируйте .env.example в .env и укажите DISCORD_TOKEN.
  pause
  exit /b 1
)

echo Запуск Consume...
node src\index.js
if errorlevel 1 (
  echo.
  echo Бот остановился с ошибкой.
  pause
)
