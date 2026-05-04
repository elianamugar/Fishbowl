const express = require('express');
const path = require('path');
const db = require('./db');
const layouts = require('express-ejs-layouts');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const SITE_ADMINS = ['elianamugar'];

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(layouts);
app.set('layout', 'layout');

app.use(session({
  secret: 'change-this-secret',
  resave: false,
  saveUninitialized: false
}));

app.use(express.urlencoded({ extended: true }));

// expose current user to views
app.use((req, res, next) => {
  if (!req.session || !req.session.userId) return next();
  db.get('SELECT id, name FROM users WHERE id = ?', [req.session.userId], (err, user) => {
    if (!err && user) res.locals.currentUser = user;
    next();
  });
});

// simple flash message helper using session
app.use((req, res, next) => {
  req.flash = (type, text) => {
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, text });
  };
  // move any flash messages into res.locals for this request
  if (req.session && req.session.flash) {
    res.locals.messages = req.session.flash;
    delete req.session.flash;
  } else {
    res.locals.messages = [];
  }
  // old form values persistence
  if (req.session && req.session.old) {
    res.locals.old = req.session.old;
    delete req.session.old;
  } else {
    res.locals.old = {};
  }
  next();
});

// allow creating a new Fishbowl (community)
app.get('/fishbowls/new', (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/login?next=/fishbowls/new');
  res.render('new_fishbowl');
});

app.post('/fishbowls', (req, res) => {
  const userId = req.session && req.session.userId;
  if (!userId) return res.redirect('/login?next=/fishbowls/new');
  const name = (req.body.name || '').trim();
  const description = (req.body.description || '').trim();
  if (!name) {
    req.session.old = { name, description };
    req.flash('error', 'Please provide a name for the Fishbowl.');
    return res.redirect('/fishbowls/new');
  }

  // ensure unique name (case-insensitive)
  db.get('SELECT id FROM communities WHERE LOWER(name) = LOWER(?)', [name], (errCheck, existing) => {
    if (errCheck) return res.status(500).send('DB error');
    if (existing) {
      req.session.old = { name, description };
      req.flash('error', 'A Fishbowl with that name already exists.');
      return res.redirect('/fishbowls/new');
    }

    db.run('INSERT INTO communities (name, description) VALUES (?, ?)', [name, description], function(err) {
      if (err) return res.status(500).send('DB error');
      const communityId = this.lastID;
      // add membership for creator as admin
      db.run('INSERT INTO memberships (user_id, community_id, is_admin, role) VALUES (?, ?, 1, "admin")', [userId, communityId], (e) => {
        if (e) console.error('Failed to create membership for creator', e);
        req.flash('success', 'Fishbowl created. You are the admin.');
        res.redirect(`/fishbowls/${communityId}`);
      });
    });
  });
});

app.get('/', (req, res) => {
  db.all('SELECT * FROM communities ORDER BY name', (err, communities) => {
    if (err) return res.status(500).send('DB error');
    res.render('index', { communities });
  });
});

app.get('/fishbowls/:id(\\d+)', (req, res) => {
  const id = req.params.id;
  const currentUserId = req.session && req.session.userId;

  db.get('SELECT * FROM communities WHERE id = ?', [id], (err, community) => {
    if (err) return res.status(500).send('DB error');
    if (!community) return res.status(404).send('Bowl not found');

    // 🔑 get current user (this defines currentUser)
    db.get('SELECT id, name FROM users WHERE id = ?', [currentUserId], (errUser, currentUser) => {
      if (errUser) return res.status(500).send('DB error');

      const isSiteAdmin = currentUser && SITE_ADMINS.includes(currentUser.name);

      // 🔑 check membership admin
      db.get(
        'SELECT is_admin, role FROM memberships WHERE user_id = ? AND community_id = ?',
        [currentUserId, id],
        (errAdmin, membership) => {
          if (errAdmin) return res.status(500).send('DB error');

          const isAdmin = !!(
            isSiteAdmin ||
            (membership && (membership.is_admin === 1 || membership.role === 'admin'))
          );

          const isMember = !!membership || isSiteAdmin;

          // 🔑 fetch posts
          db.all(
            `
            SELECT posts.*, users.name AS author_name
            FROM posts
            LEFT JOIN users ON users.id = posts.user_id
            WHERE posts.community_id = ?
            ORDER BY posts.created_at DESC
            `,
            [id],
            (errPosts, posts) => {
              if (errPosts) return res.status(500).send('DB error');

              // 🔁 final render function
              function renderCommunity() {
                const groups = {};

                posts.forEach(p => {
                  const label = new Date(p.created_at).toLocaleString('default', {
                    month: 'long',
                    year: 'numeric'
                  });

                  if (!groups[label]) groups[label] = [];
                  groups[label].push(p);
                });

                res.render('community', {
                  community,
                  groups,
                  isAdmin,
                  isMember,
                  currentUser: currentUser || null
                });
              }

              const postIds = posts.map(p => p.id);

              if (postIds.length === 0) {
                return renderCommunity();
              }

              const placeholders = postIds.map(() => '?').join(',');

              // 🔑 fetch comments
              db.all(
                `
                SELECT comments.*, users.name AS commenter_name
                FROM comments
                JOIN users ON users.id = comments.user_id
                WHERE comments.post_id IN (${placeholders})
                ORDER BY comments.created_at ASC
                `,
                postIds,
                (errComments, comments) => {
                  if (errComments) return res.status(500).send('DB error');

                  posts.forEach(post => {
                    post.comments = comments.filter(c => c.post_id === post.id);
                  });

                  return renderCommunity();
                }
              );
            }
          );
        }
      );
    });
  });
});

app.get('/fishbowls/:id(\\d+)/join', (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM communities WHERE id = ?', [id], (err, community) => {
    if (err || !community) return res.status(404).send('Bowl not found');
    res.render('join', { community });
  });
});

app.post('/fishbowls/:id(\\d+)/join', (req, res) => {
  const id = req.params.id;
  const userId = req.session && req.session.userId;
  if (!userId) return res.redirect(`/login?next=/fishbowls/${id}`);

  db.get(
  'SELECT id FROM memberships WHERE user_id = ? AND community_id = ?',
  [userId, id],
  (errCheck, existing) => {
    if (errCheck) return res.status(500).send('DB error');

    if (existing) {
      req.flash('success', 'You are already a member of this Fishbowl.');
      return res.redirect(`/fishbowls/${id}`);
    }

    db.get(
  'SELECT id FROM memberships WHERE user_id = ? AND community_id = ?',
  [userId, id],
  (errCheck, existing) => {
    if (errCheck) return res.status(500).send('DB error');

    if (existing) {
      req.flash('success', 'You are already a member of this Fishbowl.');
      return res.redirect(`/fishbowls/${id}`);
    }

    db.run(
      'INSERT INTO memberships (user_id, community_id) VALUES (?, ?)',
      [userId, id],
      (err2) => {
        if (err2) return res.status(500).send('DB error');
        req.flash('success', 'You joined this Fishbowl!');
        res.redirect(`/fishbowls/${id}`);
      }
    );
  }
);
  }
);
});

function requireAdmin(req, res, next) {
  const id = req.params.id;
  const userId = req.session && req.session.userId;

  if (!userId) {
    return res.redirect(`/login?next=/fishbowls/${id}`);
  }

  // 🔑 Get user (this defines `user`)
  db.get('SELECT id, name FROM users WHERE id = ?', [userId], (errUser, user) => {
    if (errUser) return res.status(500).send('DB error');

    // 🔑 Site admin check
    const isSiteAdmin = user && SITE_ADMINS.includes(user.name);

    if (isSiteAdmin) {
      return next();
    }

    // 🔑 Fishbowl admin check
    db.get(
      'SELECT is_admin, role FROM memberships WHERE user_id = ? AND community_id = ?',
      [userId, id],
      (err, row) => {
        if (err) return res.status(500).send('DB error');

        const isAdmin = row && (row.is_admin === 1 || row.role === 'admin');

        if (isAdmin) {
          return next();
        }

        return res.status(403).send('Forbidden - admins only');
      }
    );
  });
}

function requireMember(req, res, next) {
  const id = req.params.id;
  const userId = req.session && req.session.userId;

  if (!userId) return res.redirect(`/login?next=/fishbowls/${id}/new-post`);

  db.get(
    'SELECT id FROM memberships WHERE user_id = ? AND community_id = ?',
    [userId, id],
    (err, row) => {
      if (err) return res.status(500).send('DB error');

      if (row) return next();

      return res.status(403).send('You must join this Fishbowl before posting.');
    }
  );
}

app.get('/fishbowls/:id(\\d+)/new-post', requireMember, (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM communities WHERE id = ?', [id], (err, community) => {
    if (err || !community) return res.status(404).send('Bowl not found');
    res.render('new_post', { community });
  });
});

app.post('/fishbowls/:id(\\d+)/posts', requireMember, (req, res) => {
  const id = req.params.id;
  const title = (req.body.title || '').trim();
  const content = (req.body.content || '').trim();
  if (!title || !content) return res.redirect(`/fishbowls/${id}/new-post`);

  const created_at = new Date().toISOString();
  const userId = req.session.userId;

db.run(
  'INSERT INTO posts (community_id, user_id, title, content, created_at) VALUES (?, ?, ?, ?, ?)',
  [id, userId, title, content, created_at],
  (err) => {
    if (err) return res.status(500).send('DB error');
    res.redirect(`/fishbowls/${id}`);
  }
);
});

app.post('/posts/:postId/comments', (req, res) => {
  const postId = req.params.postId;
  const userId = req.session && req.session.userId;
  const content = (req.body.content || '').trim();

  if (!userId) return res.redirect('/login');
  if (!content) return res.redirect('back');

  db.get('SELECT community_id FROM posts WHERE id = ?', [postId], (err, post) => {
    if (err) return res.status(500).send('DB error');
    if (!post) return res.status(404).send('Post not found');

    const created_at = new Date().toISOString();

    db.run(
    'INSERT INTO comments (post_id, user_id, content, created_at) VALUES (?, ?, ?, ?)',
    [postId, userId, content, created_at],
        (err2) => {
            if (err2) return res.status(500).send('DB error');
            res.redirect(`/fishbowls/${post.community_id}`);
        }
        );
  });
});

app.post('/posts/:postId/delete', (req, res) => {
  const postId = req.params.postId;
  const userId = req.session && req.session.userId;

  if (!userId) return res.redirect('/login');

  db.get(
    `SELECT posts.*, memberships.is_admin, memberships.role
     FROM posts
     LEFT JOIN memberships
       ON memberships.community_id = posts.community_id
      AND memberships.user_id = ?
     WHERE posts.id = ?`,
    [userId, postId],
    (err, post) => {
      if (err) return res.status(500).send('DB error');
      if (!post) return res.status(404).send('Post not found');

      const isAuthor = post.user_id === userId;
      const isAdmin = post.is_admin === 1 || post.role === 'admin';

      if (!isAuthor && !isAdmin) {
        return res.status(403).send('Forbidden');
      }

      db.serialize(() => {
        db.run('DELETE FROM comments WHERE post_id = ?', [postId]);
        db.run('DELETE FROM posts WHERE id = ?', [postId], (err2) => {
          if (err2) return res.status(500).send('DB error');

          res.redirect(`/fishbowls/${post.community_id}`);
        });
      });
    }
  );
});

app.post('/comments/:commentId/delete', (req, res) => {
  const commentId = req.params.commentId;
  const userId = req.session && req.session.userId;

  if (!userId) return res.redirect('/login');

  db.get(
    `SELECT comments.*, posts.community_id, memberships.is_admin, memberships.role
     FROM comments
     JOIN posts ON posts.id = comments.post_id
     LEFT JOIN memberships
       ON memberships.community_id = posts.community_id
      AND memberships.user_id = ?
     WHERE comments.id = ?`,
    [userId, commentId],
    (err, comment) => {
      if (err) return res.status(500).send('DB error');
      if (!comment) return res.status(404).send('Comment not found');

      const isAuthor = comment.user_id === userId;
      const isAdmin = comment.is_admin === 1 || comment.role === 'admin';

      if (!isAuthor && !isAdmin) {
        return res.status(403).send('Forbidden');
      }

      db.run('DELETE FROM comments WHERE id = ?', [commentId], (err2) => {
        if (err2) return res.status(500).send('DB error');

        res.redirect(`/fishbowls/${comment.community_id}`);
      });
    }
  );
});

// Dashboard to manage members
app.get('/fishbowls/:id(\\d+)/dashboard', requireAdmin, (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM communities WHERE id = ?', [id], (err, community) => {
    if (err || !community) return res.status(404).send('Bowl not found');
    db.all(`
  SELECT 
    MIN(memberships.id) as id,
    users.id as user_id,
    users.name as name,
    MAX(memberships.is_admin) as is_admin,
    CASE
      WHEN MAX(memberships.is_admin) = 1 
        OR SUM(CASE WHEN memberships.role = 'admin' THEN 1 ELSE 0 END) > 0
      THEN 'admin'
      ELSE 'member'
    END as role
  FROM memberships
  JOIN users ON users.id = memberships.user_id
  WHERE memberships.community_id = ?
  GROUP BY users.id, users.name
  ORDER BY users.name COLLATE NOCASE ASC
`, [id], (err2, members) => {
      if (err2) return res.status(500).send('DB error');
      res.render('dashboard', { community, members, isAdmin: true });
    });
  });
});

app.post('/fishbowls/:id(\\d+)/members/:memberId/role', requireAdmin, (req, res) => {
  const id = req.params.id;
  const membershipId = req.params.memberId;
  const role = req.body.role === 'admin' ? 'admin' : 'member';
  db.all(`
  SELECT 
    MIN(memberships.id) as id,
    users.id as user_id,
    users.name as name,
    MAX(memberships.is_admin) as is_admin,
    CASE
      WHEN SUM(CASE WHEN memberships.role = 'admin' THEN 1 ELSE 0 END) > 0
      THEN 'admin'
      ELSE 'member'
    END as role
  FROM memberships
  JOIN users ON users.id = memberships.user_id
  WHERE memberships.community_id = ?
  GROUP BY users.id, users.name
  ORDER BY users.name COLLATE NOCASE ASC
`, [id], (err2, members) => {
    if (err) return res.status(500).send('DB error');
    res.redirect(`/fishbowls/${id}/dashboard`);
  });
});

app.post('/fishbowls/:id(\\d+)/delete', requireAdmin, (req, res) => {
  const id = req.params.id;

  db.serialize(() => {
    db.run('DELETE FROM posts WHERE community_id = ?', [id]);
    db.run('DELETE FROM memberships WHERE community_id = ?', [id]);
    db.run('DELETE FROM communities WHERE id = ?', [id], (err) => {
      if (err) return res.status(500).send('DB error deleting Fishbowl');

      req.flash('success', 'Fishbowl deleted.');
      res.redirect('/');
    });
  });
});

// Public members list for a community
app.get('/fishbowls/:id(\\d+)/members', (req, res) => {
  const id = req.params.id;
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const PAGE_SIZE = 10;
  const roleFilter = (req.query.role || '').trim(); // '', 'admin', 'member'
  const sort = (req.query.sort || '').trim(); // '', 'name', 'joined'

  db.get('SELECT * FROM communities WHERE id = ?', [id], (err, community) => {
    if (err || !community) return res.status(404).send('Bowl not found');

    const like = `%${q.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;

    // Build role condition
    let roleCond = '';
    const paramsForRole = [];
    if (roleFilter === 'admin') {
      roleCond = ' AND (memberships.role = ? OR memberships.is_admin = 1)';
      paramsForRole.push('admin');
    } else if (roleFilter === 'member') {
      roleCond = ' AND (memberships.role IS NULL OR memberships.role != ? ) AND memberships.is_admin = 0';
      paramsForRole.push('admin');
    }

    const countSql = `
  SELECT COUNT(DISTINCT users.id) as c
  FROM memberships
  JOIN users ON users.id = memberships.user_id
  WHERE memberships.community_id = ? 
    AND users.name LIKE ? 
    ${roleCond}
`;
    db.get(countSql, [id, like, ...paramsForRole], (errc, rowc) => {
      if (errc) return res.status(500).send('DB error');
      const total = (rowc && rowc.c) ? rowc.c : 0;
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const offset = (page - 1) * PAGE_SIZE;
      // Sorting
      let orderBy = 'memberships.created_at DESC';
      if (sort === 'name') orderBy = 'users.name COLLATE NOCASE ASC';
      if (sort === 'joined') orderBy = 'memberships.created_at DESC';

      const membersSql = `
  SELECT 
    MIN(memberships.id) as id,
    users.id as user_id,
    users.name as name,
    MAX(memberships.is_admin) as is_admin,
    CASE 
      WHEN SUM(CASE WHEN memberships.role = 'admin' THEN 1 ELSE 0 END) > 0 
      THEN 'admin' 
      ELSE 'member' 
    END as role,
    MIN(memberships.created_at) as created_at
  FROM memberships
  JOIN users ON users.id = memberships.user_id
  WHERE memberships.community_id = ? 
    AND users.name LIKE ? 
    ${roleCond}
  GROUP BY users.id, users.name
  ORDER BY ${orderBy}
  LIMIT ? OFFSET ?
`;
      db.all(membersSql, [id, like, ...paramsForRole, PAGE_SIZE, offset], (err2, members) => {
        if (err2) return res.status(500).send('DB error');
        res.render('members', { community, members, q, page, totalPages, role: roleFilter, sort });
      });
    });
  });
});

// API endpoint for live search (returns JSON)
app.get('/api/fishbowls/:id(\\d+)/members', (req, res) => {
  const id = req.params.id;
  const q = (req.query.q || '').trim();
  const roleFilter = (req.query.role || '').trim();
  const sort = (req.query.sort || '').trim();
  const limit = Math.min(100, parseInt(req.query.limit || '20', 10) || 20);

  db.get('SELECT * FROM communities WHERE id = ?', [id], (err, community) => {
    if (err || !community) return res.status(404).json({ error: 'Bowl not found' });

    const like = `%${q.replace(/%/g, '\%').replace(/_/g, '\_')}%`;
    let roleCond = '';
    const paramsForRole = [];
    if (roleFilter === 'admin') {
      roleCond = ' AND (memberships.role = ? OR memberships.is_admin = 1)';
      paramsForRole.push('admin');
    } else if (roleFilter === 'member') {
      roleCond = ' AND (memberships.role IS NULL OR memberships.role != ? ) AND memberships.is_admin = 0';
      paramsForRole.push('admin');
    }

    let orderBy = 'memberships.created_at DESC';
    if (sort === 'name') orderBy = 'users.name COLLATE NOCASE ASC';

    const membersSql = `SELECT memberships.id as id, users.name as name, memberships.is_admin as is_admin, memberships.role as role, memberships.created_at as created_at FROM memberships JOIN users ON users.id = memberships.user_id WHERE memberships.community_id = ? AND users.name LIKE ? ${roleCond} ORDER BY ${orderBy} LIMIT ?`;
    db.all(membersSql, [id, like, ...paramsForRole, limit], (err2, members) => {
      if (err2) return res.status(500).json({ error: 'DB error' });
      res.json({ community: { id: community.id, name: community.name }, members });
    });
  });
});

// Auth routes
app.get('/login', (req, res) => {
  res.render('login', { next: req.query.next || '/', name: req.query.name || '' });
});

app.post('/login', (req, res) => {
  const name = (req.body.name || '').trim();
  const password = (req.body.password || '');
  const nextUrl = req.body.next || '/';
  if (!name || !password) return res.redirect('/login');
  db.get('SELECT * FROM users WHERE name = ?', [name], (err, user) => {
    if (err) return res.status(500).send('DB error');
    if (!user) return res.redirect('/signup?next=' + encodeURIComponent(nextUrl) + '&name=' + encodeURIComponent(name));
    if (!user.password) return res.redirect('/signup?next=' + encodeURIComponent(nextUrl) + '&name=' + encodeURIComponent(name));
    const ok = bcrypt.compareSync(password, user.password);
    if (!ok) return res.redirect('/login');
    req.session.userId = user.id;
    return res.redirect(nextUrl);
  });
});

app.get('/signup', (req, res) => {
  res.render('signup', { next: req.query.next || '/', name: req.query.name || '' });
});

app.post('/signup', (req, res) => {
  const name = (req.body.name || '').trim();
  const password = (req.body.password || '');
  const nextUrl = req.body.next || '/';
  if (!name || !password) return res.redirect('/signup');
  const hash = bcrypt.hashSync(password, 10);
  db.get('SELECT * FROM users WHERE name = ?', [name], (err, user) => {
    if (err) return res.status(500).send('DB error');
    if (user) {
      // If user exists but has no password, set it
      if (!user.password) {
        db.run('UPDATE users SET password = ? WHERE id = ?', [hash, user.id], (e) => {
          if (e) return res.status(500).send('DB error');
          req.session.userId = user.id;
          return res.redirect(nextUrl);
        });
      } else {
        // user exists with password -> redirect to login
        return res.redirect('/login');
      }
    } else {
      db.run('INSERT INTO users (name, password) VALUES (?, ?)', [name, hash], function (err2) {
        if (err2) return res.status(500).send('DB error');
        req.session.userId = this.lastID;
        return res.redirect(nextUrl);
      });
    }
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// TEMP: debug route to list registered routes
app.get('/__routes', (req, res) => {
  const routes = [];
  app._router.stack.forEach(mw => {
    if (mw.route && mw.route.path) {
      const methods = Object.keys(mw.route.methods).join(',');
      routes.push({ path: mw.route.path, methods });
    }
  });
  res.json({ routes });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

/*
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
*/