import express from 'express';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';
import session from 'express-session';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.set('view engine', 'ejs');
app.use(express.static('public'));
//for Express to get values using the POST method
app.use(express.urlencoded({extended:true}));
//setting up database connection pool, replace values in red
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  waitForConnections: true
});

//setting sessions
app.set('trust proxy', 1) // trust first proxy
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-env',
  resave: false,
  saveUninitialized: false
//   cookie: { secure: true }
}))

//middleware to make fullName available in all EJS templates
app.use((req, res, next) => {
  res.locals.authenticated = Boolean(req.session.authenticated);
  res.locals.fullName = req.session.fullName || '';
   next(); //next middleware/route
});

function requireAuth(req, res, next) {
  if (!req.session.authenticated) {
    return res.redirect('/');
  }
  return next();
}

function validateRequiredFields(payload, keys) {
  return keys.every((key) => String(payload[key] || '').trim() !== '');
}

async function getAuthorChoices() {
  const [authors] = await pool.query(
    `SELECT authorId,
          CONCAT(firstName, ' ', lastName) AS authorName
      FROM authors
      ORDER BY lastName, firstName`
  );
  return authors;
}

async function getCategoryChoices() {
  const [categories] = await pool.query(
    `SELECT DISTINCT category
      FROM quotes
      WHERE category IS NOT NULL
       AND category <> ''
      ORDER BY category`
  );
  return categories.map((row) => row.category);
}

//routes
app.get('/', (req, res) => {
  if (req.session.authenticated) {
    return res.redirect('/welcome');
  }
  return res.render('login.ejs', { loginError: '' });
});

//route that checks username and password
app.post('/loginProcess', async (req, res) => {
  const { username, password } = req.body;
  const [rows] = await pool.query(
    `SELECT userId, userName, password
      FROM Users
      WHERE userName = ?`,
    [username]
  );

  if (rows.length === 0) {
    return res.status(401).render('login.ejs', { loginError: 'Wrong credentials. Try again.' });
  }

  const match = await bcrypt.compare(password || '', rows[0].password || '');

  if (!match) {
    return res.status(401).render('login.ejs', { loginError: 'Wrong credentials. Try again.' });
  }

  req.session.authenticated = true;
  req.session.fullName = rows[0].userName;
  return res.redirect('/welcome');
});

app.get('/welcome', requireAuth, async (req, res) => {
  const [[authorCountRow]] = await pool.query('SELECT COUNT(*) AS totalAuthors FROM authors');
  const [[quoteCountRow]] = await pool.query('SELECT COUNT(*) AS totalQuotes FROM quotes');

  res.render('dashboard.ejs', {
    totalAuthors: authorCountRow.totalAuthors,
    totalQuotes: quoteCountRow.totalQuotes
  });
});

app.get('/profile', requireAuth, (req, res) => {
  res.render('profile.ejs');
});

app.get('/settings', requireAuth, (req, res) => {
  res.render('settings.ejs');
});

app.post('/logout', requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.get('/admin/authors', requireAuth, async (req, res) => {
  const [authors] = await pool.query(
    `SELECT a.authorId,
          a.firstName,
          a.lastName,
          a.profession,
          a.country,
          COUNT(q.quoteId) AS quoteCount
      FROM authors a
      LEFT JOIN quotes q ON q.authorId = a.authorId
      GROUP BY a.authorId
      ORDER BY a.lastName, a.firstName`
  );

  res.render('authors-list.ejs', { authors });
});

app.get('/admin/authors/new', requireAuth, (req, res) => {
  res.render('authors-form.ejs', {
    pageTitle: 'Add New Author',
    formAction: '/admin/authors/new',
    submitLabel: 'Create Author',
    error: '',
    author: {
      firstName: '',
      lastName: '',
      dob: '',
      dod: '',
      sex: '',
      profession: '',
      country: '',
      portrait: '',
      biography: ''
    }
  });
});

app.post('/admin/authors/new', requireAuth, async (req, res) => {
  const requiredFields = ['firstName', 'lastName', 'dob', 'dod', 'sex', 'profession', 'country', 'portrait', 'biography'];
  if (!validateRequiredFields(req.body, requiredFields)) {
    return res.status(400).render('authors-form.ejs', {
      pageTitle: 'Add New Author',
      formAction: '/admin/authors/new',
      submitLabel: 'Create Author',
      error: 'All author fields are required.',
      author: req.body
    });
  }

  await pool.query(
    `INSERT INTO authors
      (firstName, lastName, dob, dod, sex, profession, country, portrait, biography)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.body.firstName,
      req.body.lastName,
      req.body.dob,
      req.body.dod,
      req.body.sex,
      req.body.profession,
      req.body.country,
      req.body.portrait,
      req.body.biography
    ]
  );

  return res.redirect('/admin/authors');
});

app.get('/admin/authors/:authorId/edit', requireAuth, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM authors WHERE authorId = ?', [req.params.authorId]);
  if (rows.length === 0) {
    return res.status(404).send('Author not found');
  }

  return res.render('authors-form.ejs', {
    pageTitle: 'Edit Author',
    formAction: `/admin/authors/${req.params.authorId}/edit`,
    submitLabel: 'Update Author',
    error: '',
    author: rows[0]
  });
});

app.post('/admin/authors/:authorId/edit', requireAuth, async (req, res) => {
  const requiredFields = ['firstName', 'lastName', 'dob', 'dod', 'sex', 'profession', 'country', 'portrait', 'biography'];
  if (!validateRequiredFields(req.body, requiredFields)) {
    return res.status(400).render('authors-form.ejs', {
      pageTitle: 'Edit Author',
      formAction: `/admin/authors/${req.params.authorId}/edit`,
      submitLabel: 'Update Author',
      error: 'All author fields are required.',
      author: { ...req.body, authorId: req.params.authorId }
    });
  }

  await pool.query(
    `UPDATE authors
       SET firstName = ?,
          lastName = ?,
          dob = ?,
          dod = ?,
          sex = ?,
          profession = ?,
          country = ?,
          portrait = ?,
          biography = ?
      WHERE authorId = ?`,
    [
      req.body.firstName,
      req.body.lastName,
      req.body.dob,
      req.body.dod,
      req.body.sex,
      req.body.profession,
      req.body.country,
      req.body.portrait,
      req.body.biography,
      req.params.authorId
    ]
  );

  return res.redirect('/admin/authors');
});

app.post('/admin/authors/:authorId/delete', requireAuth, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM quotes WHERE authorId = ?', [req.params.authorId]);
    await conn.query('DELETE FROM authors WHERE authorId = ?', [req.params.authorId]);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  return res.redirect('/admin/authors');
});

app.get('/admin/quotes', requireAuth, async (req, res) => {
  const [quotes] = await pool.query(
    `SELECT q.quoteId,
          q.quote,
          q.category,
          q.likes,
          CONCAT(a.firstName, ' ', a.lastName) AS authorName
      FROM quotes q
      JOIN authors a ON a.authorId = q.authorId
      ORDER BY q.quoteId DESC`
  );

  res.render('quotes-list.ejs', { quotes });
});

app.get('/admin/quotes/new', requireAuth, async (req, res) => {
  const authors = await getAuthorChoices();
  const categories = await getCategoryChoices();
  return res.render('quotes-form.ejs', {
    pageTitle: 'Add New Quote',
    formAction: '/admin/quotes/new',
    submitLabel: 'Create Quote',
    error: '',
    authors,
    categories,
    quoteEntry: {
      quote: '',
      authorId: '',
      category: '',
      likes: 0
    }
  });
});

app.post('/admin/quotes/new', requireAuth, async (req, res) => {
  const requiredFields = ['quote', 'authorId', 'category', 'likes'];
  if (!validateRequiredFields(req.body, requiredFields)) {
    const authors = await getAuthorChoices();
    const categories = await getCategoryChoices();
    return res.status(400).render('quotes-form.ejs', {
      pageTitle: 'Add New Quote',
      formAction: '/admin/quotes/new',
      submitLabel: 'Create Quote',
      error: 'Quote, author, category, and likes are required.',
      authors,
      categories,
      quoteEntry: req.body
    });
  }

  await pool.query(
    `INSERT INTO quotes
      (quote, authorId, category, likes)
     VALUES (?, ?, ?, ?)`,
    [req.body.quote, req.body.authorId, req.body.category, req.body.likes]
  );

  return res.redirect('/admin/quotes');
});

app.get('/admin/quotes/:quoteId/edit', requireAuth, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM quotes WHERE quoteId = ?', [req.params.quoteId]);
  if (rows.length === 0) {
    return res.status(404).send('Quote not found');
  }

  const authors = await getAuthorChoices();
  const categories = await getCategoryChoices();
  return res.render('quotes-form.ejs', {
    pageTitle: 'Edit Quote',
    formAction: `/admin/quotes/${req.params.quoteId}/edit`,
    submitLabel: 'Update Quote',
    error: '',
    authors,
    categories,
    quoteEntry: rows[0]
  });
});

app.post('/admin/quotes/:quoteId/edit', requireAuth, async (req, res) => {
  const requiredFields = ['quote', 'authorId', 'category', 'likes'];
  if (!validateRequiredFields(req.body, requiredFields)) {
    const authors = await getAuthorChoices();
    const categories = await getCategoryChoices();
    return res.status(400).render('quotes-form.ejs', {
      pageTitle: 'Edit Quote',
      formAction: `/admin/quotes/${req.params.quoteId}/edit`,
      submitLabel: 'Update Quote',
      error: 'Quote, author, category, and likes are required.',
      authors,
      categories,
      quoteEntry: { ...req.body, quoteId: req.params.quoteId }
    });
  }

  await pool.query(
    `UPDATE quotes
       SET quote = ?,
          authorId = ?,
          category = ?,
          likes = ?
      WHERE quoteId = ?`,
    [req.body.quote, req.body.authorId, req.body.category, req.body.likes, req.params.quoteId]
  );

  return res.redirect('/admin/quotes');
});

app.post('/admin/quotes/:quoteId/delete', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM quotes WHERE quoteId = ?', [req.params.quoteId]);
  return res.redirect('/admin/quotes');
});

app.get('/dbTest', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT CURDATE()');
    res.send(rows);
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Database error!');
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong.');
});

async function ensureAdminCredentials() {
  const hashedPassword = await bcrypt.hash('s3cr3t', 10);
  const [rows] = await pool.query('SELECT userId FROM Users WHERE userName = ?', ['admin']);

  if (rows.length === 0) {
    await pool.query('INSERT INTO Users (userName, password) VALUES (?, ?)', ['admin', hashedPassword]);
  } else {
    await pool.query('UPDATE Users SET password = ? WHERE userName = ?', [hashedPassword, 'admin']);
  }
}

async function startServer() {
  await ensureAdminCredentials();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Express server running on port ${PORT}`);
  });
}

startServer().catch((error) => {
  console.error('Unable to start server:', error);
  process.exit(1);
});