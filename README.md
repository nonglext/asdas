# 💬 ChatApp

Простой чат с регистрацией по ID, поиском друзей и реалтайм-сообщениями.

## Технологии
- **Backend:** Node.js + Express + Socket.io
- **Frontend:** HTML / CSS / Vanilla JS
- **Хранилище:** In-memory (данные живут пока сервер работает)

---

## 🚀 Деплой на Render

### 1. Залить код на GitHub

```bash
git init
git add .
git commit -m "init chatapp"
git remote add origin https://github.com/ТВО_ИМЯ/chatapp.git
git push -u origin main
```

### 2. Создать сервис на Render

1. Зайди на [render.com](https://render.com) и нажми **New → Web Service**
2. Подключи свой GitHub репозиторий
3. Настройки:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
4. Нажми **Deploy**

Render автоматически определит порт через переменную `PORT`.

---

## 💻 Локальный запуск

```bash
npm install
node server.js
# Открой http://localhost:3000
```

---

## Функционал

- ✅ Регистрация по уникальному ID
- ✅ Вход по ID (запоминается в localStorage)
- ✅ Поиск пользователей по ID или нику
- ✅ Запросы в друзья (принять / отклонить)
- ✅ Реалтайм-чат через WebSocket
- ✅ Индикатор онлайн/офлайн
- ✅ История сообщений (в рамках сессии)
- ✅ Счётчик непрочитанных сообщений
