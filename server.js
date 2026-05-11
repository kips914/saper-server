const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

// База данных (в файле db.json)
let DB = {
  users: [],
  posts: [],
  kruzhki: [],
  comments: [],
  subscriptions: [],
  likes: [],
  messages: [],
  notifications: []
};

const DB_FILE = path.join(__dirname, 'db.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      DB = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    }
  } catch (e) { console.error('Ошибка загрузки БД:', e); }
}
function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2));
}
loadDB();

// Загрузка файлов
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// Явные CORS заголовки
app.use(cors());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public'))); // для APK, иконок и т.д.

// Уведомления
function notify(userId, type, text) {
  DB.notifications.push({
    id: uuidv4(),
    userId,
    type,
    text,
    createdAt: new Date().toISOString(),
    read: false
  });
  saveDB();
}

// ---------- АВТОРИЗАЦИЯ ----------
app.post('/api/register', async (req, res) => {
  try {
    const { login, password, name, email } = req.body;
    if (!login || !password || !email) return res.status(400).json({ error: 'Логин, пароль и email обязательны' });
    if (DB.users.find(u => u.login === login)) return res.status(400).json({ error: 'Пользователь уже существует' });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).json({ error: 'Некорректный формат email' });
    const domain = email.split('@')[1].toLowerCase();
    const allowed = ['gmail.com', 'yandex.ru', 'mail.ru', 'outlook.com', 'icloud.com', 'proton.me'];
    if (!allowed.includes(domain)) return res.status(400).json({ error: 'Неподдерживаемый почтовый домен' });

    const hash = await bcrypt.hash(password, 10);
    const user = {
      id: uuidv4(),
      login,
      password: hash,
      name: name || login,
      avatar: null,
      desc: '',
      email,
      role: 'user',
      createdAt: new Date().toISOString()
    };
    DB.users.push(user);
    saveDB();
    res.json({ user: { ...user, password: undefined } });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    const user = DB.users.find(u => u.login === login);
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    res.json({ user: { ...user, password: undefined } });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/user/:login', (req, res) => {
  const user = DB.users.find(u => u.login === req.params.login);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ ...user, password: undefined });
});

// Обновление профиля
app.put('/api/user/:login', upload.single('avatar'), (req, res) => {
  const user = DB.users.find(u => u.login === req.params.login);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (req.body.name) user.name = req.body.name;
  if (req.body.desc) user.desc = req.body.desc;
  if (req.body.avatarEmoji) user.avatar = req.body.avatarEmoji;
  if (req.file) user.avatar = '/uploads/' + req.file.filename;
  saveDB();
  res.json({ user: { ...user, password: undefined } });
});

// ---------- ПОДПИСКИ ----------
app.get('/api/subscriptions/:login', (req, res) => {
  const subs = DB.subscriptions.filter(s => s.subscriber === req.params.login).map(s => s.target);
  res.json(subs);
});
app.post('/api/subscribe', (req, res) => {
  const { subscriber, target } = req.body;
  if (DB.subscriptions.find(s => s.subscriber === subscriber && s.target === target))
    return res.json({ status: 'already' });
  DB.subscriptions.push({ subscriber, target });
  notify(target, 'subscribe', `${subscriber} подписался на вас`);
  saveDB();
  res.json({ status: 'ok' });
});
app.post('/api/unsubscribe', (req, res) => {
  const { subscriber, target } = req.body;
  DB.subscriptions = DB.subscriptions.filter(s => !(s.subscriber === subscriber && s.target === target));
  saveDB();
  res.json({ status: 'ok' });
});

// Взаимная подписка
app.get('/api/mutual/:user1/:user2', (req, res) => {
  const sub1 = DB.subscriptions.find(s => s.subscriber === req.params.user1 && s.target === req.params.user2);
  const sub2 = DB.subscriptions.find(s => s.subscriber === req.params.user2 && s.target === req.params.user1);
  res.json({ mutual: !!(sub1 && sub2) });
});

// ---------- ПОСТЫ ----------
app.get('/api/posts', (req, res) => {
  const posts = DB.posts.map(p => {
    const author = DB.users.find(u => u.login === p.user);
    const likes = DB.likes.filter(l => l.postId === p.id && l.type === 'like').length;
    const dislikes = DB.likes.filter(l => l.postId === p.id && l.type === 'dislike').length;
    return { ...p, author: author ? { name: author.name, avatar: author.avatar } : null, likes, dislikes };
  });
  res.json(posts);
});

app.post('/api/posts', upload.array('images', 10), (req, res) => {
  const { user, text, videoUrls } = req.body;
  if (!user) return res.status(400).json({ error: 'Пользователь обязателен' });
  const images = req.files ? req.files.map(f => '/uploads/' + f.filename) : [];
  const post = {
    id: uuidv4(),
    user,
    text: text || '',
    images,
    videoUrls: videoUrls ? JSON.parse(videoUrls) : [],
    createdAt: new Date().toISOString()
  };
  DB.posts.unshift(post);
  saveDB();
  res.json(post);
});

// Лайки (toggle)
app.post('/api/posts/:id/toggle-like', (req, res) => {
  const { userId } = req.body;
  const post = DB.posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });
  const existing = DB.likes.find(l => l.postId === post.id && l.userId === userId && l.type === 'like');
  if (existing) {
    DB.likes = DB.likes.filter(l => l.id !== existing.id);
  } else {
    DB.likes = DB.likes.filter(l => !(l.postId === post.id && l.userId === userId));
    DB.likes.push({ id: uuidv4(), userId, postId: post.id, type: 'like' });
    notify(post.user, 'like', `${userId} оценил ваш пост`);
  }
  saveDB();
  const likes = DB.likes.filter(l => l.postId === post.id && l.type === 'like').length;
  const dislikes = DB.likes.filter(l => l.postId === post.id && l.type === 'dislike').length;
  res.json({ likes, dislikes });
});

app.post('/api/posts/:id/toggle-dislike', (req, res) => {
  const { userId } = req.body;
  const post = DB.posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });
  const existing = DB.likes.find(l => l.postId === post.id && l.userId === userId && l.type === 'dislike');
  if (existing) {
    DB.likes = DB.likes.filter(l => l.id !== existing.id);
  } else {
    DB.likes = DB.likes.filter(l => !(l.postId === post.id && l.userId === userId));
    DB.likes.push({ id: uuidv4(), userId, postId: post.id, type: 'dislike' });
  }
  saveDB();
  const likes = DB.likes.filter(l => l.postId === post.id && l.type === 'like').length;
  const dislikes = DB.likes.filter(l => l.postId === post.id && l.type === 'dislike').length;
  res.json({ likes, dislikes });
});

app.delete('/api/posts/:id', (req, res) => {
  const post = DB.posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Пост не найден' });
  DB.posts = DB.posts.filter(p => p.id !== req.params.id);
  DB.likes = DB.likes.filter(l => l.postId !== req.params.id);
  DB.comments = DB.comments.filter(c => c.parentId !== req.params.id || c.type !== 'post');
  saveDB();
  res.json({ status: 'ok' });
});

// ---------- КРУЖОЧКИ ----------
app.get('/api/kruzhki', (req, res) => {
  const withAuthor = DB.kruzhki.map(k => {
    const author = DB.users.find(u => u.login === k.author);
    return { ...k, authorName: author ? author.name : k.author, authorAvatar: author ? author.avatar : null };
  });
  res.json(withAuthor);
});

app.post('/api/kruzhki', upload.single('video'), (req, res) => {
  const { author } = req.body;
  if (!author || !req.file) return res.status(400).json({ error: 'Автор и видео обязательны' });
  const kruzhok = {
    id: uuidv4(),
    author,
    src: '/uploads/' + req.file.filename,
    createdAt: new Date().toISOString()
  };
  DB.kruzhki.unshift(kruzhok);
  saveDB();
  res.json(kruzhok);
});

// ---------- КОММЕНТАРИИ ----------
app.get('/api/comments/:type/:parentId', (req, res) => {
  const comments = DB.comments.filter(c => c.type === req.params.type && c.parentId === req.params.parentId);
  res.json(comments);
});

app.post('/api/comments', (req, res) => {
  const { type, parentId, user, text } = req.body;
  if (!type || !parentId || !user || !text) return res.status(400).json({ error: 'Все поля обязательны' });
  const comment = { id: uuidv4(), type, parentId, user, text, createdAt: new Date().toISOString() };
  DB.comments.push(comment);
  notify(parentId === comment.parentId ? DB.posts.find(p=>p.id===parentId)?.user : DB.kruzhki.find(k=>k.id===parentId)?.author, 'comment', `${user} оставил комментарий`);
  saveDB();
  res.json(comment);
});

app.delete('/api/comments/:id', (req, res) => {
  DB.comments = DB.comments.filter(c => c.id !== req.params.id);
  saveDB();
  res.json({ status: 'ok' });
});

// ---------- СООБЩЕНИЯ ----------
app.get('/api/messages/:user1/:user2', (req, res) => {
  const msgs = DB.messages.filter(m =>
    (m.from === req.params.user1 && m.to === req.params.user2) ||
    (m.from === req.params.user2 && m.to === req.params.user1)
  ).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  res.json(msgs);
});

app.post('/api/messages', (req, res) => {
  const { from, to, text } = req.body;
  if (!from || !to || !text) return res.status(400).json({ error: 'Все поля обязательны' });
  // проверка взаимной подписки
  const sub1 = DB.subscriptions.find(s => s.subscriber === from && s.target === to);
  const sub2 = DB.subscriptions.find(s => s.subscriber === to && s.target === from);
  if (!sub1 || !sub2) return res.status(403).json({ error: 'Только взаимные подписчики могут писать' });
  const msg = { id: uuidv4(), from, to, text, createdAt: new Date().toISOString() };
  DB.messages.push(msg);
  notify(to, 'message', `${from} отправил вам сообщение`);
  saveDB();
  res.json(msg);
});

// ---------- УВЕДОМЛЕНИЯ ----------
app.get('/api/notifications/:login', (req, res) => {
  const notifs = DB.notifications.filter(n => n.userId === req.params.login)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(notifs);
});

app.post('/api/notifications/read/:id', (req, res) => {
  const notif = DB.notifications.find(n => n.id === req.params.id);
  if (notif) { notif.read = true; saveDB(); }
  res.json({ status: 'ok' });
});

// ---------- АДМИН-СТАТИСТИКА ----------
app.get('/api/admin/stats', (req, res) => {
  const { adminLogin } = req.query;
  const admin = DB.users.find(u => u.login === adminLogin && u.role === 'admin');
  if (!admin) return res.status(403).json({ error: 'Доступ запрещён' });
  res.json({
    users: DB.users.length,
    posts: DB.posts.length,
    kruzhki: DB.kruzhki.length,
    messages: DB.messages.length
  });
});

app.listen(PORT, () => console.log(`Ranger server live on port ${PORT}`));
