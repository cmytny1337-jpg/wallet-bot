// bot.js
// Главный файл. Тут описаны все команды бота.

require('dotenv').config();
const { Telegraf } = require('telegraf');
const db = require('./database');

// Токен бота берём из файла .env (см. README — там объяснено, как его получить)
const bot = new Telegraf(process.env.BOT_TOKEN);

// Ваш telegram_id — впишите сюда свой, чтобы иметь доступ к /addbalance
// (узнать свой id можно у бота @userinfobot)
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

// Каждый раз, когда пользователь пишет боту — регистрируем его в базе,
// если он там ещё не появлялся.
bot.use((ctx, next) => {
  if (ctx.from) {
    db.getOrCreateUser(ctx.from.id, ctx.from.username);
  }
  return next();
});

// /start — приветствие
bot.start((ctx) => {
  ctx.reply(
    `Привет, ${ctx.from.first_name}! 👋\n\n` +
    `Это простой кошелёк внутри Telegram.\n\n` +
    `Команды:\n` +
    `/balance — посмотреть баланс\n` +
    `/send @username сумма — перевести деньги\n` +
    `/history — последние операции\n\n` +
    `⚠️ Обязательное условие: у получателя должен быть публичный @username в Telegram, ` +
    `и он должен хотя бы раз написать этому боту /start.`
  );
});

// /balance
bot.command('balance', (ctx) => {
  const balance = db.getBalance(ctx.from.id);
  ctx.reply(`💰 Ваш баланс: ${balance.toFixed(2)}`);
});

// /send @username 100
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

  ctx.reply(`✅ Отправлено ${amount.toFixed(2)} пользователю @${username}`);

  // Пытаемся уведомить получателя (сработает, только если он писал боту)
  const receiver = db.findByUsername(username);
  if (receiver) {
    bot.telegram.sendMessage(
      receiver.telegram_id,
      `💸 Вам перевели ${amount.toFixed(2)} от @${ctx.from.username || ctx.from.first_name}`
    ).catch(() => {}); // игнорируем ошибку, если бот заблокирован получателем
  }
});

// /history
bot.command('history', (ctx) => {
  const history = db.getHistory(ctx.from.id);

  if (history.length === 0) {
    return ctx.reply('Операций пока нет');
  }

  const myUsername = ctx.from.username;
  const lines = history.map((t) => {
    const isOutgoing = t.sender_username === myUsername;
    if (isOutgoing) {
      return `➖ ${t.amount.toFixed(2)} → @${t.receiver_username} (${t.created_at})`;
    } else {
      return `➕ ${t.amount.toFixed(2)} ← @${t.sender_username} (${t.created_at})`;
    }
  });

  ctx.reply(lines.join('\n'));
});

// /addbalance 100 — только для админа, чтобы тестировать без реальных денег
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
  ctx.reply(`Баланс пополнен на ${amount.toFixed(2)}`);
});

bot.launch();
console.log('Бот запущен ✅');

// Корректное завершение работы
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
