const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

let DB = {
  users: [],
  posts: [],
  kruzhki: [],
  comments: [],
  subscriptions: [],
  likes: [],            // { id, userId, postId, type: 'like'|'dislike' }
  messages: [],         // { id, from, to, text, createdAt }
  notifications: []     // { id, userId, type, text, createdAt, read }
};

const DB_FILE = path.join(__dirname, 'db.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) DB = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch (e) { console.error('DB load error:', e); }
}
function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2));
}
loadDB();

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ---------- УВЕДОМЛЕНИЯ ----------
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
  const { login, password, name, email } = req.body;
  if (!login || !password || !email) return res.status(400).json({ error: 'login, password and email required' });
  if (DB.users.find(u => u.login === login)) return res.status(400).json({ error: 'user exists' });
  // проверка email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return res.status(400).json({ error: 'invalid email format' });
  // проверка домена (хотя бы gmail, yandex, mail и т.п.)
  const domain = email.split('@')[1].toLowerCase();
  const allowedDomains = ['gmail.com', 'yandex.ru', 'mail.ru', 'outlook.com', 'icloud.com'];
  if (!allowedDomains.includes(domain)) return res.status(400).json({ error: 'unsupported email domain' });

  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    login,
    password: hash,
    name: name || login,
    avatar: null, // путь к файлу или эмодзи
    desc: '',
    email,
    role: 'user', // 'admin' для админа
    createdAt: new Date().toISOString()
  };
  DB.users.push(user);
  saveDB();
  res.json({ user: { ...user, password: undefined } });
});

app.post('/api/login', async (req, res) => {
  const { login, password } = req.body;
  const user = DB.users.find(u => u.login === login);
  if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'invalid credentials' });
  res.json({ user: { ...user, password: undefined } });
});

app.get('/api/user/:login', (req, res) => {
  const user = DB.users.find(u => u.login === req.params.login);
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json({ ...user, password: undefined });
});

// загрузка аватара
app.post('/api/user/avatar', upload.single('avatar'), (req, res) => {
  const { login } = req.body;
  const user = DB.users.find(u => u.login === login);
  if (!user || !req.file) return res.status(400).json({ error: 'missing data' });
  user.avatar = '/uploads/' + req.file.filename;
  saveDB();
  res.json({ avatar: user.avatar });
});

// обновление профиля (имя, описание, эмодзи)
app.put('/api/user/:login', upload.single('avatar'), (req, res) => {
  const user = DB.users.find(u => u.login === req.params.login);
  if (!user) return res.status(404).json({ error: 'not found' });
  if (req.body.name) user.name = req.body.name;
  if (req.body.desc) user.desc = req.body.desc;
  if (req.body.avatarEmoji) user.avatar = req.body.avatarEmoji; // эмодзи
  if (req.file) user.avatar = '/uploads/' + req.file.filename; // загруженный файл
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
  if (DB.subscriptions.find(s => s.subscriber === subscriber && s.target === target)) return res.json({ status: 'already' });
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
// проверка взаимной подписки
app.get('/api/mutual/:user1/:user2', (req, res) => {
  const { user1, user2 } = req.params;
  const sub1 = DB.subscriptions.find(s => s.subscriber === user1 && s.target === user2);
  const sub2 = DB.subscriptions.find(s => s.subscriber === user2 && s.target === user1);
  res.json({ mutual: !!(sub1 && sub2) });
});

// ---------- ПОСТЫ ----------
app.get('/api/posts', (req, res) => {
  const posts = DB.posts.map(p => {
    const author = DB.users.find(u => u.login === p.user);
    const likes = DB.likes.filter(l => l.postId === p.id && l.type === 'like').length;
    const dislikes = DB.likes.filter(l => l.postId === p.id && l.type === 'dislike').length;
    return { ...p, author: author ? { name: author.name, avatar: author.avatar } : { name: p.user, avatar: '?' }, likes, dislikes };
  });
  res.json(posts);
});
app.post('/api/posts', upload.array('images', 10), (req, res) => {
  const { user, text, videoUrls } = req.body;
  if (!user) return res.status(400).json({ error: 'user required' });
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

// лайки
app.post('/api/posts/:id/toggle-like', (req, res) => {
  const { userId } = req.body;
  const post = DB.posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'post not found' });
  const existing = DB.likes.find(l => l.postId === post.id && l.userId === userId && l.type === 'like');
  if (existing) {
    DB.likes = DB.likes.filter(l => l.id !== existing.id);
  } else {
    // убираем дизлайк, если был
    DB.likes = DB.likes.filter(l => !(l.postId === post.id && l.userId === userId));
    DB.likes.push({ id: uuidv4(), userId, postId: post.id, type: 'like' });
    notify(post.user, 'like', `${userId} оценил ваш пост`);
  }
  saveDB();
  const likes = DB.likes.filter(l => l.postId === post.id && l.type === 'like').length;
  const dislikes = DB.likes.filter(l => l.postId === post.id && l.type === 'dislike').length;
  res.json({ likes, dislikes, liked: !existing });
});
app.post('/api/posts/:id/toggle-dislike', (req, res) => {
  const { userId } = req.body;
  const post = DB.posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'post not found' });
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
  res.json({ likes, dislikes, disliked: !existing });
});

app.delete('/api/posts/:id', (req, res) => {
  const { userId, isAdmin } = req.body; // для проверки прав
  const post = DB.posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'not found' });
  const user = DB.users.find(u => u.login === userId);
  if (!isAdmin && post.user !== userId) return res.status(403).json({ error: 'forbidden' });
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
    return { ...k, authorName: author ? author.name : k.author, authorAvatar: author ? author.avatar : '?' };
  });
  res.json(withAuthor);
});
app.post('/api/kruzhki', upload.single('video'), (req, res) => {
  const { author } = req.body;
  if (!author || !req.file) return res.status(400).json({ error: 'author and video required' });
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

// ---------- СООБЩЕНИЯ ----------
app.get('/api/messages/:user1/:user2', (req, res) => {
  const { user1, user2 } = req.params;
  const msgs = DB.messages.filter(m =>
    (m.from === user1 && m.to === user2) || (m.from === user2 && m.to === user1)
  ).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  res.json(msgs);
});
app.post('/api/messages', (req, res) => {
  const { from, to, text } = req.body;
  if (!from || !to || !text) return res.status(400).json({ error: 'missing fields' });
  // проверяем взаимную подписку
  const sub1 = DB.subscriptions.find(s => s.subscriber === from && s.target === to);
  const sub2 = DB.subscriptions.find(s => s.subscriber === to && s.target === from);
  if (!sub1 || !sub2) return res.status(403).json({ error: 'not mutual subscribers' });
  const msg = { id: uuidv4(), from, to, text, createdAt: new Date().toISOString() };
  DB.messages.push(msg);
  notify(to, 'message', `${from} отправил вам сообщение`);
  saveDB();
  res.json(msg);
});

// ---------- УВЕДОМЛЕНИЯ ----------
app.get('/api/notifications/:login', (req, res) => {
  const notifs = DB.notifications.filter(n => n.userId === req.params.login).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(notifs);
});
app.post('/api/notifications/read/:id', (req, res) => {
  const notif = DB.notifications.find(n => n.id === req.params.id);
  if (notif) { notif.read = true; saveDB(); }
  res.json({ status: 'ok' });
});

// ---------- АДМИН-СТАТИСТИКА ----------
app.get('/api/admin/stats', (req, res) => {
  // здесь можно добавить проверку токена админа, но для простоты проверяем login в query
  const { adminLogin } = req.query;
  const admin = DB.users.find(u => u.login === adminLogin && u.role === 'admin');
  if (!admin) return res.status(403).json({ error: 'forbidden' });
  res.json({
    users: DB.users.length,
    posts: DB.posts.length,
    kruzhki: DB.kruzhki.length,
    messages: DB.messages.length
  });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
