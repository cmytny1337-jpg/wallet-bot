// bot.js
// Главный файл. Тут описаны команды бота И веб-сервер для Mini App
// (красивого интерфейса, который открывается прямо внутри Telegram).

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const db = require('./database');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL; // ссылка на мини-апп, добавим её позже

const bot = new Telegraf(BOT_TOKEN);
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

// ==================== ЧАСТЬ 1: ОБЫЧНЫЙ БОТ (команды) ====================

bot.use((ctx, next) => {
  if (ctx.from) {
    db.getOrCreateUser(ctx.from.id, ctx.from.username);
  }
  return next();
});

bot.start((ctx) => {
  const buttons = [];
  if (WEBAPP_URL) {
    buttons.push([Markup.button.webApp('💰 Открыть кошелёк', WEBAPP_URL)]);
  }

  ctx.reply(
    `Привет, ${ctx.from.first_name}! 👋\n\n` +
    `Это простой кошелёк внутри Telegram.\n\n` +
    `Команды:\n` +
    `/balance — посмотреть баланс\n` +
    `/send @username сумма — перевести деньги\n` +
    `/history — последние операции\n\n` +
    `⚠️ Обязательное условие: у получателя должен быть публичный @username в Telegram, ` +
    `и он должен хотя бы раз написать этому боту /start.`,
    buttons.length ? Markup.inlineKeyboard(buttons) : undefined
  );
});

bot.command('balance', (ctx) => {
  const balance = db.getBalance(ctx.from.id);
  ctx.reply(`💰 Ваш баланс: $${balance.toFixed(2)}`);
});

bot.command('app', (ctx) => {
  if (!WEBAPP_URL) {
    return ctx.reply('Мини-апп ещё не настроен (нет WEBAPP_URL)');
  }
  ctx.reply(
    'Откройте кошелёк 👇',
    Markup.inlineKeyboard([Markup.button.webApp('💰 Открыть кошелёк', WEBAPP_URL)])
  );
});

bot.command('send', (ctx) => {
  const parts = ctx.message.text.split(' ').filter(Boolean);

  if (parts.length !== 3) {
    return ctx.reply('Использование: /send @username сумма\nНапример: /send @friend 50');
  }

  let [, usernameRaw, amountRaw] = parts;
  const username = usernameRaw.replace('@', '');
  const amount = parseFloat(amountRaw.replace(',', '.'));

  if (isNaN(amount)) {
    return ctx.reply('Сумма указана неверно');
  }

  const result = db.transfer(ctx.from.id, username, amount);

  if (!result.ok) {
    return ctx.reply(`❌ ${result.error}`);
  }

  ctx.reply(`✅ Отправлено $${amount.toFixed(2)} пользователю @${username}`);

  const receiver = db.findByUsername(username);
  if (receiver) {
    bot.telegram.sendMessage(
      receiver.telegram_id,
      `💸 Вам перевели $${amount.toFixed(2)} от @${ctx.from.username || ctx.from.first_name}`
    ).catch(() => {});
  }
});

bot.command('history', (ctx) => {
  const history = db.getHistory(ctx.from.id);

  if (history.length === 0) {
    return ctx.reply('Операций пока нет');
  }

  const myUsername = ctx.from.username;
  const lines = history.map((t) => {
    const isOutgoing = t.sender_username === myUsername;
    if (isOutgoing) {
      return `➖ $${t.amount.toFixed(2)} → @${t.receiver_username} (${t.created_at})`;
    } else {
      return `➕ $${t.amount.toFixed(2)} ← @${t.sender_username} (${t.created_at})`;
    }
  });

  ctx.reply(lines.join('\n'));
});

bot.command('addbalance', (ctx) => {
  if (!ADMIN_IDS.includes(String(ctx.from.id))) {
    return ctx.reply('Команда недоступна');
  }

  const parts = ctx.message.text.split(' ').filter(Boolean);
  const amount = parseFloat(parts[1]);

  if (isNaN(amount)) {
    return ctx.reply('Использование: /addbalance сумма');
  }

  db.addBalance(ctx.from.id, amount);
  ctx.reply(`Баланс пополнен на $${amount.toFixed(2)}`);
});

// ==================== ЧАСТЬ 2: ВЕБ-СЕРВЕР ДЛЯ MINI APP ====================

const app = express();
app.use(express.json());

// Отдаём страницу интерфейса
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'webapp.html'));
});

// Проверка подлинности данных, которые прислал Telegram Mini App.
// Это нужно, чтобы никто посторонний не мог подделать запрос и
// притвориться другим пользователем. Алгоритм — официальный,
// описан в документации Telegram для Mini Apps.
function validateInitData(initData, botToken) {
  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');

    const pairs = [];
    for (const [key, value] of urlParams.entries()) {
      pairs.push(`${key}=${value}`);
    }
    pairs.sort();
    const dataCheckString = pairs.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    return computedHash === hash;
  } catch (e) {
    return false;
  }
}

// Достаём из initData объект пользователя
function getUserFromInitData(initData) {
  const params = new URLSearchParams(initData);
  return JSON.parse(params.get('user'));
}

// GET /api/me — возвращает username и баланс текущего пользователя
app.get('/api/me', (req, res) => {
  const { initData } = req.query;
  if (!initData || !validateInitData(initData, BOT_TOKEN)) {
    return res.status(401).json({ error: 'Не удалось подтвердить пользователя' });
  }

  const tgUser = getUserFromInitData(initData);
  const user = db.getOrCreateUser(tgUser.id, tgUser.username);

  res.json({
    username: user.username,
    balance: user.balance,
  });
});

// GET /api/history — последние операции
app.get('/api/history', (req, res) => {
  const { initData } = req.query;
  if (!initData || !validateInitData(initData, BOT_TOKEN)) {
    return res.status(401).json({ error: 'Не удалось подтвердить пользователя' });
  }

  const tgUser = getUserFromInitData(initData);
  const history = db.getHistory(tgUser.id, 30);

  res.json({
    history: history.map((t) => ({
      amount: t.amount,
      created_at: t.created_at,
      direction: t.sender_username === tgUser.username ? 'out' : 'in',
      counterparty: t.sender_username === tgUser.username ? t.receiver_username : t.sender_username,
    })),
  });
});

// POST /api/send — перевод денег
app.post('/api/send', (req, res) => {
  const { initData, to, amount } = req.body;
  if (!initData || !validateInitData(initData, BOT_TOKEN)) {
    return res.status(401).json({ error: 'Не удалось подтвердить пользователя' });
  }

  const tgUser = getUserFromInitData(initData);
  db.getOrCreateUser(tgUser.id, tgUser.username);

  const cleanUsername = String(to || '').replace('@', '').trim();
  const parsedAmount = parseFloat(amount);

  const result = db.transfer(tgUser.id, cleanUsername, parsedAmount);

  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }

  const receiver = db.findByUsername(cleanUsername);
  if (receiver) {
    bot.telegram.sendMessage(
      receiver.telegram_id,
      `💸 Вам перевели $${parsedAmount.toFixed(2)} от @${tgUser.username}`
    ).catch(() => {});
  }

  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Веб-сервер запущен на порту ${PORT} ✅`);
});

// ==================== ЗАПУСК БОТА ====================

bot.launch().then(() => {
  console.log('Бот запущен ✅');

  // Настраиваем кнопку меню (рядом с полем ввода сообщения),
  // чтобы можно было в один тап открыть мини-апп
  if (WEBAPP_URL) {
    bot.telegram.setChatMenuButton({
      menu_button: {
        type: 'web_app',
        text: 'Кошелёк',
        web_app: { url: WEBAPP_URL },
      },
    }).catch((e) => console.error('Не удалось установить кнопку меню:', e.message));
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
