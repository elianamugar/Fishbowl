const path = require('path');
const sqlite3 = require('sqlite3');
const dbPath = path.join(__dirname, 'data.db');

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    password TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS communities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS memberships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    community_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    is_admin INTEGER DEFAULT 0,
    role TEXT DEFAULT 'member'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    community_id INTEGER,
    user_id INTEGER,
    title TEXT,
    content TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
 )`);

  // Seed a couple of Fishbowls if none exist
  db.get('SELECT COUNT(*) as c FROM communities', (err, row) => {
    if (err) return console.error(err);
    if (row.c === 0) {
      const stmt = db.prepare('INSERT INTO communities (name, description) VALUES (?, ?)');
      stmt.run('Gardening', 'Community for plant lovers and gardeners');
      stmt.run('Open Source', 'Discuss and share open source projects');
      stmt.run('Photography', 'Share photos and monthly highlights');
      stmt.finalize();
    }
  });

  // Ensure memberships has is_admin column (for older runs) and seed an admin user
  db.all("PRAGMA table_info('memberships')", (err, cols) => {
    if (err) return console.error(err);
    const hasIsAdmin = cols && cols.some(c => c.name === 'is_admin');
    const hasRole = cols && cols.some(c => c.name === 'role');

    const seedAdminIfNeeded = () => {
      db.get('SELECT COUNT(*) as c FROM memberships WHERE is_admin=1 OR role="admin"', (err3, r3) => {
        if (err3) return console.error(err3);
        if (r3 && r3.c === 0) {
          db.run('INSERT INTO users (name) VALUES (?)', ['Admin'], function (err4) {
            if (err4) return console.error(err4);
            const adminId = this.lastID;
            db.each('SELECT id FROM communities', (err5, rowC) => {
              if (err5) return console.error(err5);
              db.run('INSERT INTO memberships (user_id, community_id, is_admin, role) VALUES (?, ?, 1, "admin")', [adminId, rowC.id]);
            });
          });
        }
      });
    };

    // Add missing columns sequentially, then seed admin
    const toAdd = [];
    if (!hasIsAdmin) toAdd.push('is_admin');
    if (!hasRole) toAdd.push('role');

    const alterNext = () => {
      const col = toAdd.shift();
      if (!col) return seedAdminIfNeeded();
      let sql;
      if (col === 'is_admin') sql = "ALTER TABLE memberships ADD COLUMN is_admin INTEGER DEFAULT 0";
      if (col === 'role') sql = "ALTER TABLE memberships ADD COLUMN role TEXT DEFAULT 'member'";
      db.run(sql, (err2) => {
        if (err2) console.error(`Failed to add ${col} column:`, err2);
        alterNext();
      });
    };

    alterNext();
  });

  // Ensure users has password column for older runs
  db.all("PRAGMA table_info('users')", (errU, colsU) => {
    if (errU) return console.error(errU);
    const hasPassword = colsU && colsU.some(c => c.name === 'password');
    if (!hasPassword) {
      db.run("ALTER TABLE users ADD COLUMN password TEXT", (e) => {
        if (e) console.error('Failed to add password column:', e);
      });
    }
  });
});

db.all("PRAGMA table_info('posts')", (errP, colsP) => {
  if (errP) return console.error(errP);

  const hasUserId = colsP && colsP.some(c => c.name === 'user_id');

  if (!hasUserId) {
    db.run("ALTER TABLE posts ADD COLUMN user_id INTEGER", (e) => {
      if (e) console.error('Failed to add user_id column to posts:', e);
    });
  }
});

module.exports = db;
