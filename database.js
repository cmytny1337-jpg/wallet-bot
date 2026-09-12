// database.js
// Тут всё, что связано с базой данных.
// Используем better-sqlite3 — это база данных, которая просто хранится
// в одном файле (wallet.db) рядом с проектом. Ничего отдельно ставить не нужно.

const Database = require('better-sqlite3');
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
`);

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

// Возвращает баланс пользователя
function getBalance(telegramId) {
  const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(telegramId);
  return user ? user.balance : 0;
}

// Самая важная функция — перевод денег между пользователями.
// Всё происходит в одной "транзакции" базы данных: либо обе
// операции (списание и зачисление) проходят успешно, либо
// откатываются обе — деньги никогда не "теряются" и не дублируются.
function transfer(fromTelegramId, toUsername, amount) {
  if (amount <= 0) {
    return { ok: false, error: 'Сумма должна быть больше нуля' };
  }

  const sender = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(fromTelegramId);
  const receiver = findByUsername(toUsername);

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
  getBalance,
  transfer,
  getHistory,
  addBalance,
  createDeposit,
  getDeposit,
  confirmDeposit,
};
