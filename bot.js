// bot.js
// Главный файл. Тут описаны команды бота, веб-сервер для Mini App
// (красивого интерфейса, который открывается прямо внутри Telegram)
// и приём пополнений реальной криптой через CryptoBot.

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const db = require('./database');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL; // ссылка на мини-апп
const CRYPTOBOT_TOKEN = process.env.CRYPTOBOT_TOKEN; // токен из @CryptoBot -> Crypto Pay -> Create App
const BOT_USERNAME = process.env.BOT_USERNAME; // без @, нужен для кнопки "Назад в бота" после оплаты

const CRYPTOBOT_API = 'https://pay.crypt.bot/api';
// Только USDT: у неё курс стабильно ~$1, поэтому "занёс X USDT" = "зачислено X$"
// без искажений. TON/BTC/ETH сильно колеблются в цене, а без отдельного
// сервиса котировок посчитать их в долларах правильно нельзя — раньше
// это могло привести к неверному зачислению баланса.
const SUPPORTED_ASSETS = ['USDT'];

const bot = new Telegraf(BOT_TOKEN);
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

// ==================== ЧАСТЬ 0: CRYPTOBOT (пополнение) ====================

// Обёртка над Crypto Pay API. Документация: https://help.crypt.bot/crypto-pay-api
async function cryptoBotRequest(method, body) {
  const res = await fetch(`${CRYPTOBOT_API}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Crypto-Pay-API-Token': CRYPTOBOT_TOKEN,
    },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.error ? JSON.stringify(data.error) : 'CryptoBot API error');
  }
  return data.result;
}

// Создаёт инвойс на оплату и сохраняет его в базу со статусом "pending".
async function createTopupInvoice(telegramId, asset, amount) {
  const payload = {
    asset,
    amount: String(amount),
    description: 'Пополнение кошелька',
    payload: JSON.stringify({ telegram_id: telegramId }),
    allow_comments: false,
    allow_anonymous: false,
    expires_in: 1800, // 30 минут на оплату
  };
  if (BOT_USERNAME) {
    payload.paid_btn_name = 'callback';
    payload.paid_btn_url = `https://t.me/${BOT_USERNAME}`;
  }

  const invoice = await cryptoBotRequest('createInvoice', payload);
  db.createDeposit(invoice.invoice_id, telegramId, asset, Number(amount));
  return invoice;
}

// Отправляет реальную крипту пользователю обратно на его аккаунт
// CryptoBot — используется для вывода. spendId должен быть уникальным
// для каждой попытки перевода (это ключ идемпотентности CryptoBot —
// он не даст выполнить один и тот же перевод дважды, даже если запрос
// случайно продублируется).
async function cryptoBotTransfer(telegramId, asset, amount, spendId) {
  return cryptoBotRequest('transfer', {
    user_id: telegramId,
    asset,
    amount: String(amount),
    spend_id: spendId,
    comment: 'Вывод из кошелька',
  });
}

// Проверка подписи вебхука — чтобы никто посторонний не мог прислать
// поддельное "оплачено" и накрутить себе баланс. Алгоритм из документации
// CryptoBot: secret = sha256(токен), подпись = hmac_sha256(тело, secret).
function verifyCryptoBotSignature(rawBody, signatureHeader) {
  if (!CRYPTOBOT_TOKEN || !signatureHeader) return false;
  const secret = crypto.createHash('sha256').update(CRYPTOBOT_TOKEN).digest();
  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return computed === signatureHeader;
}

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
    `/send @username сумма — перевести деньги (можно и по Telegram ID)\n` +
    `/topup ВАЛЮТА сумма — пополнить криптой (например: /topup USDT 10)\n` +
    `/withdraw ВАЛЮТА сумма — вывести обратно в криптовалюту\n` +
    `/history — последние операции\n\n` +
    `🎁 Сейчас проходит розыгрыш $10 000 на 10 победителей — участвуйте: /giveaway\n` +
    `(выигрыш можно тратить внутри бота, но не вывести в крипту — вывести можно только то, что вы реально внесли пополнением)\n\n` +
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
    return ctx.reply('Использование: /send @username_или_id сумма\nНапример: /send @friend 50\nили: /send 7402594843 50');
  }

  let [, identifierRaw, amountRaw] = parts;
  const identifier = identifierRaw.replace('@', '');
  const amount = parseFloat(amountRaw.replace(',', '.'));

  if (isNaN(amount)) {
    return ctx.reply('Сумма указана неверно');
  }

  const result = db.transfer(ctx.from.id, identifier, amount);

  if (!result.ok) {
    return ctx.reply(`❌ ${result.error}`);
  }

  const receiver = db.resolveRecipient(identifier);
  ctx.reply(`✅ Отправлено $${amount.toFixed(2)} пользователю ${receiver.username ? '@' + receiver.username : receiver.telegram_id}`);

  if (receiver) {
    bot.telegram.sendMessage(
      receiver.telegram_id,
      `💸 Вам перевели $${amount.toFixed(2)} от @${ctx.from.username || ctx.from.first_name}`
    ).catch(() => {});
  }
});

bot.command('topup', async (ctx) => {
  if (!CRYPTOBOT_TOKEN) {
    return ctx.reply('Пополнение пока не настроено (нет CRYPTOBOT_TOKEN)');
  }

  const parts = ctx.message.text.split(' ').filter(Boolean);
  if (parts.length !== 3) {
    return ctx.reply(
      `Использование: /topup ВАЛЮТА сумма\nНапример: /topup USDT 10\n\nДоступные валюты: ${SUPPORTED_ASSETS.join(', ')}`
    );
  }

  const asset = parts[1].toUpperCase();
  const amount = parseFloat(parts[2].replace(',', '.'));

  if (!SUPPORTED_ASSETS.includes(asset)) {
    return ctx.reply(`Неизвестная валюта. Доступные: ${SUPPORTED_ASSETS.join(', ')}`);
  }
  if (isNaN(amount) || amount <= 0) {
    return ctx.reply('Сумма указана неверно');
  }

  try {
    const invoice = await createTopupInvoice(ctx.from.id, asset, amount);
    ctx.reply(
      `Инвойс создан на ${amount} ${asset}. Нажмите кнопку ниже, чтобы оплатить:`,
      Markup.inlineKeyboard([Markup.button.url('💳 Оплатить', invoice.pay_url)])
    );
  } catch (e) {
    console.error('Ошибка создания инвойса:', e.message);
    ctx.reply('Не удалось создать счёт на оплату. Попробуйте позже.');
  }
});

const GIVEAWAY_WINNERS = 10;
const GIVEAWAY_AMOUNT_EACH = 1000;

bot.command('giveaway', (ctx) => {
  const result = db.joinGiveaway(ctx.from.id);
  const count = db.getGiveawayCount();

  if (result.alreadyJoined) {
    return ctx.reply(`Вы уже участвуете в розыгрыше 🎁\nВсего участников: ${count}`);
  }

  ctx.reply(
    `🎁 Вы участвуете в розыгрыше!\n` +
    `Разыгрывается $${GIVEAWAY_AMOUNT_EACH * GIVEAWAY_WINNERS} между ${GIVEAWAY_WINNERS} победителями (по $${GIVEAWAY_AMOUNT_EACH} каждому).\n\n` +
    `Сейчас участников: ${count}`
  );
});

bot.command('drawgiveaway', async (ctx) => {
  if (!ADMIN_IDS.includes(String(ctx.from.id))) {
    return ctx.reply('Команда недоступна');
  }

  const result = db.drawGiveaway(GIVEAWAY_WINNERS, GIVEAWAY_AMOUNT_EACH);

  if (!result.ok) {
    return ctx.reply(`Не удалось провести розыгрыш: ${result.error}`);
  }

  const lines = result.winners.map((w) => `@${w.username || w.telegramId} — $${w.amount}`);
  ctx.reply(`🎉 Розыгрыш завершён!\n\n${lines.join('\n')}`);

  for (const w of result.winners) {
    bot.telegram.sendMessage(
      w.telegramId,
      `🎉 Поздравляем! Вы выиграли $${w.amount} в розыгрыше кошелька! Баланс уже зачислен.`
    ).catch(() => {});
  }
});

bot.command('withdraw', async (ctx) => {
  if (!CRYPTOBOT_TOKEN) {
    return ctx.reply('Вывод пока не настроен (нет CRYPTOBOT_TOKEN)');
  }

  const parts = ctx.message.text.split(' ').filter(Boolean);
  if (parts.length !== 3) {
    const withdrawable = db.getWithdrawable(ctx.from.id);
    return ctx.reply(
      `Использование: /withdraw ВАЛЮТА сумма\nНапример: /withdraw USDT 10\n\nДоступно к выводу: $${withdrawable.toFixed(2)}`
    );
  }

  const asset = parts[1].toUpperCase();
  const amount = parseFloat(parts[2].replace(',', '.'));

  if (!SUPPORTED_ASSETS.includes(asset)) {
    return ctx.reply(`Неизвестная валюта. Доступные: ${SUPPORTED_ASSETS.join(', ')}`);
  }
  if (isNaN(amount) || amount <= 0) {
    return ctx.reply('Сумма указана неверно');
  }

  const begin = db.beginWithdrawal(ctx.from.id, asset, amount);
  if (!begin.ok) {
    return ctx.reply(`❌ ${begin.error}`);
  }

  try {
    await cryptoBotTransfer(ctx.from.id, asset, amount, `withdraw-${begin.withdrawalId}`);
    db.markWithdrawalSuccess(begin.withdrawalId);
    ctx.reply(`✅ $${amount.toFixed(2)} (${asset}) отправлено на ваш аккаунт CryptoBot.`);
  } catch (e) {
    console.error('Ошибка вывода:', e.message);
    db.markWithdrawalFailed(begin.withdrawalId);
    ctx.reply('❌ Не удалось выполнить вывод. Деньги возвращены на баланс. Попробуйте позже.');
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
      const to = t.receiver_username ? `@${t.receiver_username}` : (t.comment || 'вывод');
      return `➖ $${t.amount.toFixed(2)} → ${to} (${t.created_at})`;
    } else {
      const from = t.sender_username ? `@${t.sender_username}` : (t.comment || 'пополнение');
      return `➕ $${t.amount.toFixed(2)} ← ${from} (${t.created_at})`;
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

// Сохраняем "сырое" тело запроса — оно нужно для проверки подписи
// вебхука от CryptoBot (подпись считается по точным исходным байтам).
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

// Отдаём страницу интерфейса
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'webapp.html'));
});

// Проверка подлинности данных, которые прислал Telegram Mini App.
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
    withdrawable: user.real_balance,
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
      counterparty: t.sender_username === tgUser.username
        ? (t.receiver_username || t.comment || 'вывод')
        : (t.sender_username || t.comment || 'пополнение'),
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

  const cleanIdentifier = String(to || '').replace('@', '').trim();
  const parsedAmount = parseFloat(amount);

  const result = db.transfer(tgUser.id, cleanIdentifier, parsedAmount);

  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }

  const receiver = db.resolveRecipient(cleanIdentifier);
  if (receiver) {
    bot.telegram.sendMessage(
      receiver.telegram_id,
      `💸 Вам перевели $${parsedAmount.toFixed(2)} от @${tgUser.username}`
    ).catch(() => {});
  }

  res.json({ ok: true });
});

// ==================== PIN-КОД (замок мини-аппа) ====================
// Это экран блокировки внутри мини-аппа — как в обычных приложениях
// банков. Он не заменяет проверку Telegram (initData всё ещё
// обязателен для каждого запроса), а просто не даёт увидеть баланс
// с первого взгляда, если кто-то возьмёт разблокированный телефон.

app.get('/api/pin-status', (req, res) => {
  const { initData } = req.query;
  if (!initData || !validateInitData(initData, BOT_TOKEN)) {
    return res.status(401).json({ error: 'Не удалось подтвердить пользователя' });
  }
  const tgUser = getUserFromInitData(initData);
  db.getOrCreateUser(tgUser.id, tgUser.username);
  res.json({ hasPin: db.hasPin(tgUser.id) });
});

app.post('/api/pin-set', (req, res) => {
  const { initData, pin } = req.body;
  if (!initData || !validateInitData(initData, BOT_TOKEN)) {
    return res.status(401).json({ error: 'Не удалось подтвердить пользователя' });
  }
  if (!/^\d{6}$/.test(String(pin || ''))) {
    return res.status(400).json({ error: 'PIN-код должен состоять из 6 цифр' });
  }
  const tgUser = getUserFromInitData(initData);
  db.getOrCreateUser(tgUser.id, tgUser.username);
  db.setPin(tgUser.id, pin);
  res.json({ ok: true });
});

app.post('/api/pin-verify', (req, res) => {
  const { initData, pin } = req.body;
  if (!initData || !validateInitData(initData, BOT_TOKEN)) {
    return res.status(401).json({ error: 'Не удалось подтвердить пользователя' });
  }
  const tgUser = getUserFromInitData(initData);
  const ok = db.verifyPin(tgUser.id, pin);
  res.json({ ok });
});

// ==================== РОЗЫГРЫШ (в мини-аппе) ====================

app.get('/api/giveaway-status', (req, res) => {
  const { initData } = req.query;
  if (!initData || !validateInitData(initData, BOT_TOKEN)) {
    return res.status(401).json({ error: 'Не удалось подтвердить пользователя' });
  }
  const tgUser = getUserFromInitData(initData);
  db.getOrCreateUser(tgUser.id, tgUser.username);
  res.json({
    joined: db.hasJoinedGiveaway(tgUser.id),
    count: db.getGiveawayCount(),
    winners: GIVEAWAY_WINNERS,
    amountEach: GIVEAWAY_AMOUNT_EACH,
  });
});

app.post('/api/giveaway-join', (req, res) => {
  const { initData } = req.body;
  if (!initData || !validateInitData(initData, BOT_TOKEN)) {
    return res.status(401).json({ error: 'Не удалось подтвердить пользователя' });
  }
  const tgUser = getUserFromInitData(initData);
  db.getOrCreateUser(tgUser.id, tgUser.username);
  const result = db.joinGiveaway(tgUser.id);
  res.json({ ok: true, alreadyJoined: Boolean(result.alreadyJoined), count: db.getGiveawayCount() });
});

// GET /api/topup-assets — список валют, которые можно выбрать в мини-аппе
app.get('/api/topup-assets', (req, res) => {
  res.json({ assets: SUPPORTED_ASSETS, enabled: Boolean(CRYPTOBOT_TOKEN) });
});

// POST /api/topup — создаёт инвойс CryptoBot и возвращает ссылку на оплату
app.post('/api/topup', async (req, res) => {
  const { initData, asset, amount } = req.body;
  if (!initData || !validateInitData(initData, BOT_TOKEN)) {
    return res.status(401).json({ error: 'Не удалось подтвердить пользователя' });
  }
  if (!CRYPTOBOT_TOKEN) {
    return res.status(400).json({ error: 'Пополнение пока не настроено' });
  }

  const tgUser = getUserFromInitData(initData);
  db.getOrCreateUser(tgUser.id, tgUser.username);

  const cleanAsset = String(asset || '').toUpperCase();
  const parsedAmount = parseFloat(amount);

  if (!SUPPORTED_ASSETS.includes(cleanAsset)) {
    return res.status(400).json({ error: 'Неизвестная валюта' });
  }
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Сумма указана неверно' });
  }

  try {
    const invoice = await createTopupInvoice(tgUser.id, cleanAsset, parsedAmount);
    res.json({ ok: true, pay_url: invoice.pay_url });
  } catch (e) {
    console.error('Ошибка создания инвойса:', e.message);
    res.status(500).json({ error: 'Не удалось создать счёт на оплату' });
  }
});

// POST /api/withdraw — вывод реально внесённых средств обратно в крипту
app.post('/api/withdraw', async (req, res) => {
  const { initData, asset, amount } = req.body;
  if (!initData || !validateInitData(initData, BOT_TOKEN)) {
    return res.status(401).json({ error: 'Не удалось подтвердить пользователя' });
  }
  if (!CRYPTOBOT_TOKEN) {
    return res.status(400).json({ error: 'Вывод пока не настроен' });
  }

  const tgUser = getUserFromInitData(initData);
  db.getOrCreateUser(tgUser.id, tgUser.username);

  const cleanAsset = String(asset || '').toUpperCase();
  const parsedAmount = parseFloat(amount);

  if (!SUPPORTED_ASSETS.includes(cleanAsset)) {
    return res.status(400).json({ error: 'Неизвестная валюта' });
  }
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Сумма указана неверно' });
  }

  const begin = db.beginWithdrawal(tgUser.id, cleanAsset, parsedAmount);
  if (!begin.ok) {
    return res.status(400).json({ error: begin.error });
  }

  try {
    await cryptoBotTransfer(tgUser.id, cleanAsset, parsedAmount, `withdraw-${begin.withdrawalId}`);
    db.markWithdrawalSuccess(begin.withdrawalId);
    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка вывода:', e.message);
    db.markWithdrawalFailed(begin.withdrawalId);
    res.status(500).json({ error: 'Не удалось выполнить вывод. Деньги возвращены на баланс.' });
  }
});

// POST /webhook/cryptobot — сюда CryptoBot присылает уведомление об оплате.
// Этот адрес нужно вписать в настройках приложения в @CryptoBot (Crypto Pay
// -> My Apps -> ваше приложение -> Webhook). Полный адрес:
// https://ваш-домен.up.railway.app/webhook/cryptobot
app.post('/webhook/cryptobot', (req, res) => {
  const signature = req.get('crypto-pay-api-signature');

  if (!verifyCryptoBotSignature(req.rawBody, signature)) {
    return res.status(401).send('bad signature');
  }

  // Отвечаем сразу 200, чтобы CryptoBot не повторял вебхук,
  // а обработку делаем после ответа.
  res.status(200).send('ok');

  const update = req.body;
  if (update.update_type !== 'invoice_paid') return;

  const invoice = update.payload;
  const result = db.confirmDeposit(invoice.invoice_id);

  if (result.ok) {
    bot.telegram.sendMessage(
      result.telegramId,
      `✅ Зачислено ${result.amount} ${result.asset}. Баланс пополнен.`
    ).catch(() => {});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Веб-сервер запущен на порту ${PORT} ✅`);
});

// ==================== ЗАПУСК БОТА ====================

bot.launch().then(() => {
  console.log('Бот запущен ✅');

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
