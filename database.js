// database.js
// Тут всё, что связано с базой данных.
// Используем better-sqlite3 — это база данных, которая просто хранится
// в одном файле (wallet.db) рядом с проектом. Ничего отдельно ставить не нужно.

const Database = require('better-sqlite3');
const crypto = require('crypto');
const db = new Database('wallet.db');

// Включаем проверку внешних ключей (для целостности данных)
db.pragma('journal_mode = WAL');

// Создаём таблицы, если их ещё нет.
// users — хранит telegram_id, username и текущий баланс.
// transactions — журнал всех переводов, чтобы показывать историю.
// deposits — журнал пополнений через CryptoBot (крипта), со статусом,
// чтобы один и тот же платёж нельзя было зачислить дважды.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE NOT NULL,
    username TEXT,
    balance REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id INTEGER,
    to_user_id INTEGER,
    amount REAL NOT NULL,
    comment TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id TEXT UNIQUE NOT NULL,
    telegram_id INTEGER NOT NULL,
    asset TEXT NOT NULL,
    amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    paid_at TEXT
  );

  CREATE TABLE IF NOT EXISTS giveaway_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE NOT NULL,
    joined_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Миграция: добавляем колонку pin_hash, если её ещё нет
// (нужно, потому что таблица users уже могла существовать без неё)
const userColumns = db.prepare("PRAGMA table_info(users)").all();
if (!userColumns.some((c) => c.name === 'pin_hash')) {
  db.exec('ALTER TABLE users ADD COLUMN pin_hash TEXT');
}

// Находит пользователя по его telegram_id.
// Если пользователя ещё нет в базе — создаёт его с балансом 0.
function getOrCreateUser(telegramId, username) {
  let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);

  if (!user) {
    db.prepare('INSERT INTO users (telegram_id, username, balance) VALUES (?, ?, 0)')
      .run(telegramId, username || null);
    user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  } else if (username && user.username !== username) {
    // Обновляем username, если пользователь его сменил в Telegram
    db.prepare('UPDATE users SET username = ? WHERE telegram_id = ?').run(username, telegramId);
    user.username = username;
  }

  return user;
}

// Ищет пользователя по username (без @)
function findByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

// Ищет пользователя по telegram_id
function findByTelegramId(telegramId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
}

// Универсальный поиск получателя: принимает либо @username, либо
// числовой Telegram ID — определяет тип автоматически.
// (Настоящего блокчейн-адреса тут нет — это внутренняя система,
// поэтому переводы возможны только между пользователями этого бота.)
function resolveRecipient(identifierRaw) {
  const identifier = String(identifierRaw).trim().replace('@', '');

  if (/^\d+$/.test(identifier)) {
    const byId = findByTelegramId(Number(identifier));
    if (byId) return byId;
  }

  return findByUsername(identifier);
}

// Возвращает баланс пользователя
function getBalance(telegramId) {
  const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(telegramId);
  return user ? user.balance : 0;
}

// Самая важная функция — перевод денег между пользователями.
// Всё происходит в одной "транзакции" базы данных: либо обе
// операции (списание и зачисление) проходят успешно, либо
// откатываются обе — деньги никогда не "теряются" и не дублируются.
function transfer(fromTelegramId, toIdentifier, amount) {
  if (amount <= 0) {
    return { ok: false, error: 'Сумма должна быть больше нуля' };
  }

  const sender = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(fromTelegramId);
  const receiver = resolveRecipient(toIdentifier);

  if (!receiver) {
    return { ok: false, error: 'Получатель не найден. Он должен хотя бы раз запустить бота (/start)' };
  }

  if (sender.id === receiver.id) {
    return { ok: false, error: 'Нельзя перевести самому себе' };
  }

  if (sender.balance < amount) {
    return { ok: false, error: 'Недостаточно средств' };
  }

  // db.transaction гарантирует атомарность — это ключевой момент
  // для любой денежной операции.
  const runTransfer = db.transaction(() => {
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amount, sender.id);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, receiver.id);
    db.prepare(
      'INSERT INTO transactions (from_user_id, to_user_id, amount) VALUES (?, ?, ?)'
    ).run(sender.id, receiver.id, amount);
  });

  runTransfer();

  return { ok: true };
}

// История последних операций пользователя (и отправленных, и полученных)
function getHistory(telegramId, limit = 10) {
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  if (!user) return [];

  return db.prepare(`
    SELECT t.*, 
           su.username AS sender_username, 
           ru.username AS receiver_username
    FROM transactions t
    LEFT JOIN users su ON su.id = t.from_user_id
    LEFT JOIN users ru ON ru.id = t.to_user_id
    WHERE t.from_user_id = ? OR t.to_user_id = ?
    ORDER BY t.created_at DESC
    LIMIT ?
  `).all(user.id, user.id, limit);
}

// Пополнение баланса вручную — пригодится для тестов
// (в реальном проекте эту функцию защищают и вызывают только
// после реальной оплаты через платёжный шлюз)
function addBalance(telegramId, amount) {
  db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?').run(amount, telegramId);
}

// ==================== ДЕПОЗИТЫ (пополнение через CryptoBot) ====================

// Сохраняет созданный инвойс со статусом "pending" — до того, как он оплачен.
// invoiceId — это ID, который вернул CryptoBot при создании инвойса.
function createDeposit(invoiceId, telegramId, asset, amount) {
  db.prepare(
    'INSERT INTO deposits (invoice_id, telegram_id, asset, amount, status) VALUES (?, ?, ?, ?, ?)'
  ).run(String(invoiceId), telegramId, asset, amount, 'pending');
}

function getDeposit(invoiceId) {
  return db.prepare('SELECT * FROM deposits WHERE invoice_id = ?').get(String(invoiceId));
}

// Подтверждает оплату по вебхуку от CryptoBot.
// Защищено от двойного зачисления: если депозит уже был отмечен
// как "paid" ранее (например, вебхук пришёл повторно), баланс
// второй раз не зачисляется.
function confirmDeposit(invoiceId) {
  const deposit = getDeposit(invoiceId);

  if (!deposit) {
    return { ok: false, error: 'Депозит не найден' };
  }

  if (deposit.status === 'paid') {
    return { ok: false, alreadyProcessed: true };
  }

  const runConfirm = db.transaction(() => {
    db.prepare(
      "UPDATE deposits SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE invoice_id = ?"
    ).run(String(invoiceId));

    db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?')
      .run(deposit.amount, deposit.telegram_id);

    const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(deposit.telegram_id);

    db.prepare(
      'INSERT INTO transactions (from_user_id, to_user_id, amount, comment) VALUES (NULL, ?, ?, ?)'
    ).run(user.id, deposit.amount, `Пополнение (${deposit.asset} через CryptoBot)`);
  });

  runConfirm();

  return { ok: true, telegramId: deposit.telegram_id, amount: deposit.amount, asset: deposit.asset };
}

module.exports = {
  getOrCreateUser,
  findByUsername,
  findByTelegramId,
  resolveRecipient,
  getBalance,
  transfer,
  getHistory,
  addBalance,
  createDeposit,
  getDeposit,
  confirmDeposit,
  joinGiveaway,
  getGiveawayCount,
  drawGiveaway,
  hasJoinedGiveaway,
  hasPin,
  setPin,
  verifyPin,
};

// ==================== PIN-КОД ====================
// Это экран-замок для самого мини-аппа (как у обычных банковских
// приложений) — он не заменяет и не усиливает защиту Telegram,
// а просто не даёт открыть кошелёк с первого взгляда, если кто-то
// возьмёт в руки уже разблокированный телефон.

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

function hasPin(telegramId) {
  const user = findByTelegramId(telegramId);
  return Boolean(user && user.pin_hash);
}

function setPin(telegramId, pin) {
  db.prepare('UPDATE users SET pin_hash = ? WHERE telegram_id = ?').run(hashPin(pin), telegramId);
}

function verifyPin(telegramId, pin) {
  const user = findByTelegramId(telegramId);
  if (!user || !user.pin_hash) return false;
  return user.pin_hash === hashPin(pin);
}

// ==================== РОЗЫГРЫШ ====================

// Участие в розыгрыше — просто фиксируем telegram_id.
// UNIQUE не даст записаться дважды.
function joinGiveaway(telegramId) {
  const already = db.prepare('SELECT 1 FROM giveaway_entries WHERE telegram_id = ?').get(telegramId);
  if (already) {
    return { ok: false, alreadyJoined: true };
  }
  db.prepare('INSERT INTO giveaway_entries (telegram_id) VALUES (?)').run(telegramId);
  return { ok: true };
}

function getGiveawayCount() {
  const row = db.prepare('SELECT COUNT(*) AS c FROM giveaway_entries').get();
  return row.c;
}

function hasJoinedGiveaway(telegramId) {
  return Boolean(db.prepare('SELECT 1 FROM giveaway_entries WHERE telegram_id = ?').get(telegramId));
}

// Проводит розыгрыш: случайно выбирает winnersCount участников,
// начисляет каждому amountEach, записывает в историю операций,
// и очищает список участников (чтобы можно было запустить новый розыгрыш).
// Всё — одной атомарной транзакцией.
function drawGiveaway(winnersCount, amountEach) {
  const entries = db.prepare('SELECT telegram_id FROM giveaway_entries').all();

  if (entries.length === 0) {
    return { ok: false, error: 'Нет участников' };
  }

  // Перемешиваем и берём первых N (или всех, если участников меньше)
  const shuffled = entries.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const winners = shuffled.slice(0, Math.min(winnersCount, shuffled.length));

  const runDraw = db.transaction(() => {
    for (const w of winners) {
      db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?')
        .run(amountEach, w.telegram_id);

      const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(w.telegram_id);

      db.prepare(
        'INSERT INTO transactions (from_user_id, to_user_id, amount, comment) VALUES (NULL, ?, ?, ?)'
      ).run(user.id, amountEach, 'Выигрыш в розыгрыше');
    }
    db.prepare('DELETE FROM giveaway_entries').run();
  });

  runDraw();

  const winnerUsers = winners.map((w) => {
    const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(w.telegram_id);
    return { telegramId: w.telegram_id, username: user.username, amount: amountEach };
  });

  return { ok: true, winners: winnerUsers };
}
