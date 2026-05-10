const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

// Хранилище в памяти + файл
let DB = {
  users: [],
  posts: [],
  kruzhki: [],
  comments: [],
  subscriptions: []
};

const DB_FILE = path.join(__dirname, 'db.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      DB = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    }
  } catch (e) { console.error('DB load error:', e); }
}
function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2));
}
loadDB();

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 100 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ---------- Авторизация ----------
app.post('/api/register', async (req, res) => {
  const { login, password, name } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'login and password required' });
  if (DB.users.find(u => u.login === login)) return res.status(400).json({ error: 'user exists' });
  const hash = await bcrypt.hash(password, 10);
  const user = { id: uuidv4(), login, password: hash, name: name || login, avatar: login[0].toUpperCase(), desc: '', createdAt: new Date().toISOString() };
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

// ---------- Подписки ----------
app.get('/api/subscriptions/:login', (req, res) => {
  const subs = DB.subscriptions.filter(s => s.subscriber === req.params.login).map(s => s.target);
  res.json(subs);
});
app.post('/api/subscribe', (req, res) => {
  const { subscriber, target } = req.body;
  if (DB.subscriptions.find(s => s.subscriber === subscriber && s.target === target)) return res.json({ status: 'already' });
  DB.subscriptions.push({ subscriber, target });
  saveDB();
  res.json({ status: 'ok' });
});
app.post('/api/unsubscribe', (req, res) => {
  const { subscriber, target } = req.body;
  DB.subscriptions = DB.subscriptions.filter(s => !(s.subscriber === subscriber && s.target === target));
  saveDB();
  res.json({ status: 'ok' });
});

// ---------- Посты ----------
app.get('/api/posts', (req, res) => {
  const postsWithAuthor = DB.posts.map(p => {
    const author = DB.users.find(u => u.login === p.user);
    return { ...p, author: author ? { name: author.name, avatar: author.avatar } : { name: p.user, avatar: '?' } };
  });
  res.json(postsWithAuthor);
});

app.post('/api/posts', upload.array('images', 10), (req, res) => {
  const { user, text, videoUrls } = req.body;
  if (!user || (!text && !req.files?.length && !videoUrls)) return res.status(400).json({ error: 'content required' });
  const images = req.files ? req.files.map(f => '/uploads/' + f.filename) : [];
  const parsedVideos = videoUrls ? JSON.parse(videoUrls) : [];
  const post = {
    id: uuidv4(),
    user,
    text: text || '',
    images,
    videoUrls: parsedVideos,
    likes: 0,
    dislikes: 0,
    views: 0,
    createdAt: new Date().toISOString()
  };
  DB.posts.unshift(post);
  saveDB();
  res.json(post);
});

app.post('/api/posts/:id/like', (req, res) => {
  const post = DB.posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'not found' });
  post.likes = (post.likes || 0) + 1;
  saveDB();
  res.json({ likes: post.likes });
});
app.post('/api/posts/:id/dislike', (req, res) => {
  const post = DB.posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'not found' });
  post.dislikes = (post.dislikes || 0) + 1;
  saveDB();
  res.json({ dislikes: post.dislikes });
});
app.delete('/api/posts/:id', (req, res) => {
  DB.posts = DB.posts.filter(p => p.id !== req.params.id);
  DB.comments = DB.comments.filter(c => c.parentId !== req.params.id || c.type !== 'post');
  saveDB();
  res.json({ status: 'ok' });
});

// ---------- Кружочки ----------
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
    likes: 0,
    createdAt: new Date().toISOString()
  };
  DB.kruzhki.unshift(kruzhok);
  saveDB();
  res.json(kruzhok);
});

// ---------- Комментарии (для постов и кружочков) ----------
app.get('/api/comments/:type/:parentId', (req, res) => {
  const { type, parentId } = req.params;
  const comments = DB.comments.filter(c => c.type === type && c.parentId === parentId);
  res.json(comments);
});

app.post('/api/comments', (req, res) => {
  const { type, parentId, user, text } = req.body;
  if (!type || !parentId || !user || !text) return res.status(400).json({ error: 'missing fields' });
  const comment = { id: uuidv4(), type, parentId, user, text, createdAt: new Date().toISOString() };
  DB.comments.push(comment);
  saveDB();
  res.json(comment);
});

app.delete('/api/comments/:id', (req, res) => {
  DB.comments = DB.comments.filter(c => c.id !== req.params.id);
  saveDB();
  res.json({ status: 'ok' });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));