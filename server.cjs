'use strict';
/* BENGA ENVIOS — servidor (sem dependências externas, Node 18+).
   Serve o site (public/index.html) e a API (/api/*). Dados em data/benga.json (com cópia diária). */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');

/* lê o ficheiro .env (se existir) sem precisar de bibliotecas; variáveis já definidas no ambiente têm prioridade */
try { fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => { const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (m && !l.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2'); }); } catch { }
const PORT = +process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || ((process.env.VERCEL === '1') ? '/tmp/benga-data' : path.join(__dirname, 'data')));
const DB_FILE = path.join(DATA_DIR, 'benga.json');
const BLOB_DB_PATH = String(process.env.BLOB_DB_PATH || 'benga/data/benga.json').replace(/^\/+/, '');
let initPromise = null;
let initialized = false;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
const FACEBOOK_APP_ID = (process.env.FACEBOOK_APP_ID || '').trim();
const FACEBOOK_APP_SECRET = (process.env.FACEBOOK_APP_SECRET || '').trim();
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const EMAIL_FROM = (process.env.EMAIL_FROM || '').trim();
const SESSION_MS = 7 * 24 * 3600 * 1000;
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/;
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const plusMinutes = mins => new Date(Date.now() + mins * 60000).toISOString();

/* ---------- segurança: palavras-passe e sessões ---------- */
const hashPw = pw => { const salt = crypto.randomBytes(16).toString('hex'); return 'scrypt$' + salt + '$' + crypto.scryptSync(pw, salt, 64).toString('hex'); };
const DUMMY = hashPw('x-dummy-password');
const checkPw = (pw, h) => { try { const [, salt, hex] = String(h || DUMMY).split('$'); const a = crypto.scryptSync(String(pw), salt, 64), b = Buffer.from(hex, 'hex'); return !!h && a.length === b.length && crypto.timingSafeEqual(a, b); } catch { return false; } };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

/* ---------- base de dados (ficheiro JSON, escrita atómica) ---------- */
const defaults = () => ({
  nid: 1, seqs: {}, users: [], orders: [], ev: [], notif: [], addr: [], log: [], rev: [], support: [], sessions: {}, pending: {},
  cargo: ['Computador', 'Celular Android', 'iPhone', 'PlayStation', 'Roupa / Caixa / Outra mercadoria'].map((name, i) => ({ id: 1000 + i, name })),
  S: {
    company: 'BENGA ENVIOS', slogan: 'O seu mundo, sem limites.', nif: '', hours: '', phone: '', email: '', whatsapp: '+351938421392', whatsapp2: '+351931743081', instagram: '@aj_envios',
    price_per_kg: 0,
    addr_ao: 'Ex-combatentes, Prédio 236, 3.° andar', addr_pt: 'Rua Pires Antunes n.º 11, Queluz Belas, 2745-327, R/C A',
    stat_envios: 0, stat_kg: 0, stat_clientes: 0,
    pay_holder: 'Rachid Gomes', pay_nib: '0040.0000.5256.1892.1014.3', pay_ao_method: 'Multicaixa Express', pay_iban: 'PT50 0193 0000 10507750890 11', pay_pt_method: 'MB WAY / Transferência', pay_info: 'Use o número da encomenda como referência e envie o comprovativo pelo WhatsApp. Aguarde a confirmação antes de avançar.', pay_methods: 'Transferência bancária — sem pagamento online',
    pricing: {
      computer: [[1,99.99,25],[100,299.99,35],[300,399.99,40],[400,499.99,50],[500,599.99,60],[600,799.99,70],[800,900,80],[900.000001,999999999,100]],
      android: [[1,99.99,10],[100,299.99,15],[300,399.99,25],[400,499.99,30],[500,599.99,35],[600,799.99,45],[800,900,50],[900.000001,999999999,65]],
      iphone: [['iPhone X',35],['iPhone 11',45],['iPhone 12',45],['iPhone 13',55],['iPhone 14',55],['iPhone 15',65],['iPhone 16',65],['iPhone 17',85]],
      playstation: [['PS3',35],['PS4',47.97],['PS5',67.97]],
      computerDays: '5–8 dias úteis', androidDays: '5–8 dias úteis', playstationDays: '7 dias úteis', customsIncluded: true, packagingIncluded: true, currency: 'EUR'
    },
    states: 'Pendente,Aprovada,Em preparação,Em trânsito,Chegou ao destino,Em entrega,Entregue,Recusada,Cancelada',
    notif_approve: 'sim', notif_refuse: 'sim', notif_payment: 'sim', notif_status: 'sim',
    zones: [{ name: 'Luanda', province: 'Luanda', min: 0, max: 0 }, { name: 'Portugal', province: 'Portugal', min: 0, max: 0 }]
  }
});
let D;
function mergeDefaults(d) {
  const base = defaults();
  if (!d || typeof d !== 'object') d = base;
  for (const k of Object.keys(base)) if (!(k in d)) d[k] = base[k];
  if (!d.S || typeof d.S !== 'object') d.S = {};
  for (const k of Object.keys(base.S)) if (!(k in d.S)) d.S[k] = base.S[k];
  if (!d.pending) d.pending = {};
  if (!d.S.pricing) d.S.pricing = base.S.pricing;
  if (!d.S.whatsapp2) d.S.whatsapp2 = base.S.whatsapp2;
  if (!d.S.instagram) d.S.instagram = base.S.instagram;
  if (!d.S.pay_holder) d.S.pay_holder = 'Rachid Gomes';
  if (!d.S.pay_nib) d.S.pay_nib = '0040.0000.5256.1892.1014.3';
  if (!d.S.pay_ao_method) d.S.pay_ao_method = 'Multicaixa Express';
  if (!d.S.pay_iban) d.S.pay_iban = 'PT50 0193 0000 10507750890 11';
  if (!d.S.pay_pt_method) d.S.pay_pt_method = 'MB WAY / Transferência';
  return d;
}
async function blobFns() {
  if (process.env.BENGA_USE_BLOB !== '1' && process.env.VERCEL !== '1') return null;
  try { return await import('@vercel/blob'); }
  catch (e) { console.warn('[BENGA] Blob indisponível; a aplicação continuará com armazenamento temporário.', e.message); return null; }
}
async function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // On Vercel, persistent state lives in a private Vercel Blob object.
  const bf = await blobFns();
  if (bf) {
    try {
      const r = await bf.get(BLOB_DB_PATH, { access: 'private', useCache: false });
      if (r && r.stream) {
        const text = await new Response(r.stream).text();
        D = mergeDefaults(JSON.parse(text));
        initialized = true;
        return;
      }
    } catch (e) {
      if (e && (e.statusCode === 404 || e.status === 404 || /not found/i.test(String(e.message)))) {
        // First deployment: start from the intentionally empty defaults.
      } else {
        // A missing/unlinked Blob store must never make the whole site return 500.
        console.warn('[BENGA] Não foi possível ler o Blob; a sessão continuará com armazenamento temporário.', e.message);
      }
    }
  }
  if (fs.existsSync(DB_FILE)) D = mergeDefaults(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  else D = defaults();
  initialized = true;
}
async function save() {
  const serialized = JSON.stringify(D);
  try {
    const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, serialized); fs.renameSync(tmp, DB_FILE);
    const dir = path.join(DATA_DIR, 'backups'), f = path.join(dir, 'benga-' + new Date().toISOString().slice(0, 10) + '.json');
    if (!fs.existsSync(f)) { fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(DB_FILE, f); fs.readdirSync(dir).sort().slice(0, -30).forEach(x => fs.unlinkSync(path.join(dir, x))); }
  } catch (e) { console.error('Aviso: falha na cópia local de segurança:', e.message); }
  const bf = await blobFns();
  if (bf) {
    try {
      await bf.put(BLOB_DB_PATH, serialized, { access: 'private', addRandomSuffix: false, allowOverwrite: true });
    } catch (e) {
      console.warn('[BENGA] Falha ao guardar no Blob; dados permanecem apenas no armazenamento temporário desta instância.', e.message);
    }
  }
}
async function seedAdmin() {
  const existingAdmins = D.users.filter(u => u.role === 'admin');
  if (existingAdmins.length > 1) { D.users = D.users.filter((u, i) => u.role !== 'admin' || i === D.users.indexOf(existingAdmins[0])); await save(); }
  if (D.users.some(u => u.role === 'admin')) return;
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase(), pw = process.env.ADMIN_PASSWORD || '';
  if (!EMAIL_RE.test(email) || pw.length < 10) { console.error('\nPrimeira execução: defina ADMIN_EMAIL e ADMIN_PASSWORD (mín. 10 caracteres) para criar a conta de administrador.\n'); process.exit(1); }
  D.users.push({ id: D.nid++, name: process.env.ADMIN_NAME || 'Administrador BENGA', email, phone: '', role: 'admin', pw: hashPw(pw), created_at: now() });
  if (!D.S.email) D.S.email = email;
  await save(); console.log('Conta de administrador criada: ' + email);
}

/* ---------- utilitários ---------- */
class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const E = (m, s = 400) => { throw new HttpError(s, m); };
const T = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const ipOf = req => TRUST_PROXY ? (String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress) : req.socket.remoteAddress;
const isSecure = req => !!req.socket.encrypted || process.env.FORCE_SECURE === '1' || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
const hits = new Map(), fails = new Map();
const limited = (key, max, win) => { const t = Date.now(), a = (hits.get(key) || []).filter(x => t - x < win); if (a.length >= max) { hits.set(key, a); return true; } a.push(t); hits.set(key, a); return false; };
const failCount = (key, win = 15 * 60e3) => { const t = Date.now(), a = (fails.get(key) || []).filter(x => t - x < win); fails.set(key, a); return a.length; };
const addFail = key => { const a = fails.get(key) || []; a.push(Date.now()); fails.set(key, a); };
setInterval(() => { const t = Date.now(); for (const [k, a] of hits) if (!a.some(x => t - x < 3600e3)) hits.delete(k); for (const [k, a] of fails) if (!a.some(x => t - x < 900e3)) fails.delete(k); }, 600e3).unref();

const pubUser = u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, photo: u.photo || null, prefs: u.prefs || 'sim', blocked: !!u.blocked, created_at: u.created_at, has_password: !!u.pw, provider: u.provider || null });
const note = (uid, text) => { D.notif.push({ user_id: uid, text, created_at: now() }); if (D.notif.length > 5000) D.notif = D.notif.slice(-4000); };
const noteStaff = text => D.users.filter(u => u.role !== 'client' && !u.blocked).forEach(u => note(u.id, text));
const logA = (u, action, detail) => { D.log.push({ user_id: u ? u.id : null, name: u ? u.name : 'Sistema', action, detail: T(detail, 300), created_at: now() }); if (D.log.length > 3000) D.log = D.log.slice(-2500); };
const evAdd = (o, status, n) => D.ev.push({ order_id: o.id, status, note: n || null, created_at: now() });
const killSessions = (uid, except) => { for (const [k, s] of Object.entries(D.sessions)) if (s.uid === uid && k !== except) delete D.sessions[k]; };

function cookiesOf(req) { const o = {}; (req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) { try { o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); } catch { } } }); return o; }
function sessionOf(req) {
  const t = cookiesOf(req).benga_sid; if (!t) return {};
  const key = sha(t), s = D.sessions[key]; if (!s) return {};
  if (s.exp < Date.now()) { delete D.sessions[key]; return {}; }
  const u = D.users.find(x => x.id === s.uid); if (!u || u.blocked) return {};
  return { u, key };
}
function cookieStr(req, token, maxAge) { return `benga_sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}` + (isSecure(req) ? '; Secure' : ''); }
function startSession(ctx, uid) {
  const t = crypto.randomBytes(32).toString('hex'), now_ = Date.now();
  for (const [k, s] of Object.entries(D.sessions)) if (s.exp < now_) delete D.sessions[k];
  D.sessions[sha(t)] = { uid, exp: now_ + SESSION_MS };
  ctx.cookie = cookieStr(ctx.req, t, SESSION_MS / 1000);
}

async function verifyGoogle(cred) {
  if (!GOOGLE_CLIENT_ID) E('Login com Google não está ativo.', 404);
  let t;
  try { const r = await fetch((process.env.GOOGLE_TOKENINFO_URL || 'https://oauth2.googleapis.com/tokeninfo') + '?id_token=' + encodeURIComponent(String(cred || '')));
    if (!r.ok) E('Não foi possível validar a conta Google.', 401); t = await r.json(); }
  catch (e) { if (e instanceof HttpError) throw e; E('Não foi possível contactar a Google. Tente de novo.', 502); }
  if (t.aud !== GOOGLE_CLIENT_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(t.iss) || String(t.email_verified) !== 'true' || !t.email || +t.exp * 1000 < Date.now()) E('Conta Google inválida.', 401);
  return t;
}

function rateBand(value, rows) { for (const [min, max, rate] of rows) if (value >= min && value <= max) return Number(rate); return null; }
function calcNewOrder(b) {
  const p = D.S.pricing; const qty = Math.max(1, Math.min(1000, parseInt(b.quantity) || 1)); const type = T(b.type, 40); let ship = 0, purchase = null, deadline = '—', model = T(b.model, 60);
  if (type === 'computer' || type === 'android') {
    purchase = num(b.purchase_value); if (!(purchase >= 1)) E('Indique o valor de compra.');
    ship = rateBand(purchase, p[type]); if (ship == null) E('Não foi possível calcular a tarifa para esse valor.');
    deadline = type === 'computer' ? p.computerDays : p.androidDays;
  } else if (type === 'iphone') {
    const row = p.iphone.find(x => x[0] === model); if (!row) E('Modelo de iPhone inválido.'); ship = Number(row[1]); deadline = 'Tarifa fixa por unidade';
  } else if (type === 'playstation') {
    const row = p.playstation.find(x => x[0] === model); if (!row) E('Modelo de PlayStation inválido.'); ship = Number(row[1]); deadline = p.playstationDays;
  } else E('Tipo de mercadoria inválido.');
  const shipping = ship * qty, purchaseTotal = purchase == null ? 0 : purchase * qty;
  return { type, model, quantity: qty, purchase_value: purchase, shipping_total: shipping, total_eur: purchaseTotal + shipping, deadline };
}
async function sendVerificationEmail(email, name, code) {
  if (process.env.EMAIL_DEV_MODE === '1') { console.log(`[EMAIL DEV] Código BENGA para ${email}: ${code}`); return; }
  if (!RESEND_API_KEY || !EMAIL_FROM) E('O serviço de e-mail ainda não está configurado no servidor.', 503);
  const r = await fetch('https://api.resend.com/emails', { method:'POST', headers:{ 'Authorization':'Bearer '+RESEND_API_KEY, 'Content-Type':'application/json' }, body:JSON.stringify({ from:EMAIL_FROM, to:[email], subject:'BENGA ENVIOS — Código de verificação', html:`<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px"><h2 style="color:#0b3b72">BENGA ENVIOS</h2><p>Olá ${T(name,80)},</p><p>Use este código para confirmar o seu e-mail:</p><div style="font-size:36px;font-weight:800;letter-spacing:8px;text-align:center;padding:18px;background:#edf5ff;border-radius:14px;color:#0b3b72">${code}</div><p>Válido durante 10 minutos.</p></div>` }) });
  if (!r.ok) { const txt = await r.text(); console.error('Resend:', txt); E('Não foi possível enviar o e-mail de verificação.', 502); }
}
async function oauthToken(url, body) { const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)}); const t=await r.json().catch(()=>({})); if(!r.ok) E(t.error_description||'Falha no login social.',502); return t; }

function urlSearch(req,key){ return new URL(req.url,'http://localhost').searchParams.get(key) || ''; }
async function socialFinish(ctx,email,name,provider){
  const adminEmail=(process.env.ADMIN_EMAIL||'').trim().toLowerCase(); if(email===adminEmail) E('Esta conta é reservada ao administrador.',403);
  let x=D.users.find(y=>y.email===email); if(x && x.role!=='client') E('Esta conta pertence à administração.',403); if(x && x.blocked) E('Conta bloqueada. Contacte a BENGA.',403);
  if(!x){ x={id:D.nid++,name,email,phone:'',role:'client',pw:null,provider,created_at:now(),email_verified:true}; D.users.push(x); logA(x,'register','nova conta ('+provider+')'); }
  startSession(ctx,x.id); return {role:'client',name:x.name,email:x.email};
}

/* ---------- API ---------- */
async function api(ctx) {
  const { m, p, b, u, key, ip } = ctx, ok = { ok: 1 };
  const need = (...r) => { if (!u) E('Sessão inválida.', 401); if (r.length && !r.includes(u.role)) E('Sem permissão.', 403); };
  const only = (...ms) => { if (!ms.includes(m)) E('Método não permitido.', 405); };

  if (p === '/health') return ok;

  if (p === '/public') {
    const reviews = D.rev.filter(r => r.status === 'Publicada');
    const avg = reviews.length ? (reviews.reduce((a,r)=>a+Number(r.stars||0),0)/reviews.length) : 0;
    return {
      company: D.S.company, slogan: D.S.slogan, whatsapp: D.S.whatsapp, whatsapp2: D.S.whatsapp2, instagram: D.S.instagram,
      addr_ao: D.S.addr_ao, addr_pt: D.S.addr_pt, pricing: D.S.pricing,
      stat_envios: D.orders.length, stat_clientes: D.users.filter(u=>u.role==='client').length, stat_kg: D.orders.reduce((a,o)=>a+num(o.weight||0),0),
      review_count: reviews.length, review_average: Math.round(avg*10)/10, reviews: reviews.slice().sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,12).map(({user_id,...r})=>r),
      cargo: D.cargo.map(c=>({...c}))
    };
  }

  if (p === '/me' && m === 'GET') { need(); return pubUser(u); }
  if (p === '/me' && m === 'PUT') {
    need();
    if (b.name !== undefined) { const n = T(b.name, 100); if (n.length < 2) E('Indique o seu nome.'); u.name = n; }
    if (b.phone !== undefined) u.phone = T(b.phone, 30);
    if (b.email !== undefined && T(b.email, 120).toLowerCase() !== u.email) { const e = T(b.email, 120).toLowerCase(); if (!EMAIL_RE.test(e)) E('E-mail inválido.'); if (D.users.some(x => x.email === e)) E('Este e-mail já está em uso.'); u.email = e; }
    if (b.prefs !== undefined) u.prefs = b.prefs === 'não' ? 'não' : 'sim';
    if (b.photo) { if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.photo) || b.photo.length > 250000) E('Imagem inválida ou demasiado grande.'); u.photo = b.photo; }
    if (b.password !== undefined && b.password !== '') {
      const np = String(b.password); if (np.length < 8 || np.length > 200) E('A palavra-passe deve ter pelo menos 8 caracteres.');
      if (u.pw && !checkPw(b.current_password || '', u.pw)) E('A palavra-passe atual está incorreta.');
      u.pw = hashPw(np); killSessions(u.id, key); logA(u, 'password', 'palavra-passe alterada');
    }
    return ok;
  }

  /* --- autenticação --- */
  if (p === '/auth/login') {
    only('POST'); const email=T(b.email,120).toLowerCase(), fk='e:'+email, fi='i:'+ip;
    if (failCount(fk)>=8 || failCount(fi)>=25) E('Demasiadas tentativas. Aguarde alguns minutos e tente de novo.',429);
    const x=D.users.find(x=>x.email===email), good=checkPw(String(b.password||''),x&&x.pw);
    if(!x || !good || x.blocked) { addFail(fk); addFail(fi); E(x&&x.blocked?'Conta bloqueada. Contacte a BENGA.':'E-mail ou palavra-passe incorretos.',401); }
    if(email===(process.env.ADMIN_EMAIL||'').trim().toLowerCase() && x.role!=='admin') E('Conta administrativa indisponível.',403);
    fails.delete(fk); startSession(ctx,x.id); logA(x,'login','início de sessão'); return { role:x.role, name:x.name, email:x.email };
  }
  if (p === '/auth/register/request') {
    only('POST'); if(limited('reg:'+ip,10,3600e3)) E('Demasiados registos a partir desta ligação. Tente mais tarde.',429);
    const name=T(b.name,100), email=T(b.email,120).toLowerCase(), phone=T(b.phone,30), pw=String(b.password||'');
    if(name.length<2 || !EMAIL_RE.test(email) || pw.length<8 || pw.length>200) E('Preencha nome, e-mail e palavra-passe (mínimo 8 caracteres).');
    const adminEmail=(process.env.ADMIN_EMAIL||'').trim().toLowerCase(); if(email===adminEmail) E('Este e-mail está reservado ao único administrador.',409);
    if (limited('verify-send:'+email, 5, 15*60e3)) E('Demasiados pedidos de verificação. Aguarde alguns minutos.',429);
    if(D.users.some(x=>x.email===email)) E('Este e-mail já está registado. Faça login.',409);
    const old=D.pending[email]||null; const code=String(crypto.randomInt(100000, 1000000));
    D.pending[email]={ name, email, phone, pw: old?.pw || hashPw(pw), code:sha(code), expires:Date.now()+10*60e3, created_at:now() };
    await sendVerificationEmail(email,name,code);
    return {ok:1,email,expires_at:D.pending[email].expires};
  }
  if (p === '/auth/register/resend') {
    only('POST'); const email=T(b.email,120).toLowerCase(), x=D.pending[email]; if(!x) E('Não existe cadastro pendente para esse e-mail.',404); if (limited('verify-resend:'+email, 5, 15*60e3)) E('Demasiados pedidos de novo código. Aguarde alguns minutos.',429); const code=String(crypto.randomInt(100000, 1000000)); x.code=sha(code); x.expires=Date.now()+10*60e3; await sendVerificationEmail(email,x.name,code); return {ok:1,email};
  }
  if (p === '/auth/register/verify') {
    only('POST'); const email=T(b.email,120).toLowerCase(), code=T(b.code,10), x=D.pending[email]; if(!x) E('Não existe uma verificação pendente.',404); if(x.expires<Date.now()){delete D.pending[email];E('O código expirou. Peça um novo código.',410);} if(sha(code)!==x.code) E('Código incorreto.',401);
    const u={id:D.nid++,name:x.name,email:x.email,phone:x.phone,role:'client',pw:x.pw,created_at:now(),provider:'password',email_verified:true}; D.users.push(u); delete D.pending[email]; startSession(ctx,u.id); logA(u,'register','nova conta verificada'); return {ok:1,role:'client',name:u.name,email:u.email};
  }
  if (p === '/auth/register') { return await api({...ctx,p:'/auth/register/request'}); }
  if (p === '/auth/logout') { only('POST'); if(key)delete D.sessions[key]; ctx.cookie=cookieStr(ctx.req,'',0); return ok; }
  if (p === '/auth/logout-all') { only('POST'); need(); killSessions(u.id); ctx.cookie=cookieStr(ctx.req,'',0); return ok; }

  // Social login: configure provider credentials in environment variables; both flows create client accounts only.
  if (p === '/auth/google/start' && m === 'GET') {
    if(!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) E('Login com Google ainda não está configurado.',503); const redirect=`${new URL(ctx.req.url,'http://localhost').origin}/api/auth/google/callback`; const u=`https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=${encodeURIComponent('openid email profile')}&access_type=offline&prompt=select_account`; return {redirect:u};
  }
  if (p === '/auth/google/callback' && m === 'GET') {
    if(!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) E('Login com Google ainda não está configurado.',503); const code=urlSearch(ctx.req,'code'); if(!code) E('Código Google em falta.',400); const redirect=`${new URL(ctx.req.url,'http://localhost').origin}/api/auth/google/callback`; const tok=await oauthToken('https://oauth2.googleapis.com/token',{code,client_id:GOOGLE_CLIENT_ID,client_secret:GOOGLE_CLIENT_SECRET,redirect_uri:redirect,grant_type:'authorization_code'}); const r=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:'Bearer '+tok.access_token}}); const prof=await r.json(); if(!r.ok || !prof.email || !prof.email_verified) E('Conta Google inválida.',401); return await socialFinish(ctx,String(prof.email).toLowerCase(),T(prof.name||prof.email.split('@')[0],100),'google');
  }
  if (p === '/auth/facebook/start' && m === 'GET') {
    if(!FACEBOOK_APP_ID || !FACEBOOK_APP_SECRET) E('Login com Facebook ainda não está configurado.',503); const redirect=`${new URL(ctx.req.url,'http://localhost').origin}/api/auth/facebook/callback`; const u=`https://www.facebook.com/dialog/oauth?client_id=${encodeURIComponent(FACEBOOK_APP_ID)}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=email,public_profile`; return {redirect:u};
  }
  if (p === '/auth/facebook/callback' && m === 'GET') {
    if(!FACEBOOK_APP_ID || !FACEBOOK_APP_SECRET) E('Login com Facebook ainda não está configurado.',503); const code=urlSearch(ctx.req,'code'); if(!code) E('Código Facebook em falta.',400); const redirect=`${new URL(ctx.req.url,'http://localhost').origin}/api/auth/facebook/callback`; const tok=await oauthToken('https://graph.facebook.com/oauth/access_token',{code,client_id:FACEBOOK_APP_ID,client_secret:FACEBOOK_APP_SECRET,redirect_uri:redirect}); const r=await fetch(`https://graph.facebook.com/me?fields=id,name,email&access_token=${encodeURIComponent(tok.access_token)}`); const prof=await r.json(); if(!r.ok || !prof.email) E('O Facebook não devolveu um e-mail utilizável.',400); return await socialFinish(ctx,String(prof.email).toLowerCase(),T(prof.name||prof.email.split('@')[0],100),'facebook');
  }
  if (p === '/auth/google') {
    // Backwards-compatible credential endpoint.
    only('POST'); const t=await verifyGoogle(b.credential), email=T(t.email,120).toLowerCase(); return await socialFinish(ctx,email,T(t.name||email.split('@')[0],100),'google');
  }

  /* --- rastreio público --- */
  if (p.startsWith('/track/')) {
    if (limited('trk:' + ip, 40, 60e3)) E('Demasiadas consultas. Aguarde um minuto.', 429);
    const code = decodeURIComponent(p.slice(7)).trim().toUpperCase(), o = D.orders.find(o => o.tracking_code && o.tracking_code === code);
    if (!o) E('Código não encontrado. Encomendas pendentes ou recusadas não têm código de rastreio.', 404);
    return { code: o.tracking_code, client: o.name.split(' ')[0], origin: o.origin, destination: o.destination, weight: o.weight, cargo: o.cargo_type || o.type, type: o.type, model: o.model || null, quantity: o.quantity, status: o.status, location: o.location || 'Registada', payment_status: o.payment_status, date: o.created_at, value: o.total_eur, total_eur: o.total_eur, deadline: o.deadline, events: D.ev.filter(e => e.order_id === o.id).map(({ order_id, ...e }) => e) };
  }

  /* --- cliente --- */
  if (p === '/orders' && m === 'GET') { need('client'); return D.orders.filter(o=>o.user_id===u.id).slice().reverse(); }
  if (p === '/orders' && m === 'POST') {
    need('client');
    const body=b; const calc=calcNewOrder(body); const city=['Angola','Portugal']; const origin=T(body.origin,20)||'Angola', destination=T(body.destination,20)||'Portugal';
    if(!city.includes(origin)||!city.includes(destination)||origin===destination) E('Origem e destino devem ser Angola e Portugal (diferentes).');
    const y=new Date().getFullYear(); D.seqs[y]=(D.seqs[y]||0)+1; const tracking=`BEN-${y}-${String(D.seqs[y]).padStart(6,'0')}`;
    const ord={id:D.nid++,user_id:u.id,name:u.name,phone:u.phone,email:u.email,origin,destination,type:calc.type,model:calc.model,purchase_value:calc.purchase_value,quantity:calc.quantity,shipping_total:calc.shipping_total,deadline:calc.deadline,description:T(body.description||'',500),delivery_address:T(body.delivery_address||'',300),notes:T(body.notes||'',500),weight:num(body.weight||0),volumes:calc.quantity,status:'Pendente',tracking_code:tracking,payment_status:'Pendente',total_eur:Math.round(calc.total_eur*100)/100,created_at:now(),location:'Registada'};
    D.orders.push(ord); evAdd(ord,'Encomenda criada','Pedido registado no sistema.'); note(u.id,`Encomenda ${tracking} criada. O código de rastreio foi gerado automaticamente.`); noteStaff(`Nova encomenda ${tracking} criada por ${u.name}.`); logA(u,'order_create',tracking);
    return {id:ord.id,code:tracking,status:ord.status,total:ord.total_eur,shipping:ord.shipping_total,deadline:ord.deadline};
  }
  if (p === '/payments') { need('client'); return D.orders.filter(o => o.user_id === u.id).map(o => ({ created_at: o.created_at, amount: o.total_eur, method: 'Transferência bancária', status: o.payment_status, tracking_code: o.tracking_code, payment_deadline: o.payment_deadline || null })); }
  if (p === '/payment-info') { need('client'); const orders=D.orders.filter(o=>o.user_id===u.id&&o.tracking_code); const active=orders.filter(o=>o.payment_status!=='Pago'&&o.payment_status!=='Comprovativo submetido'&&(!o.payment_deadline||Date.parse(o.payment_deadline)>Date.now())).sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||''))[0]; return { available:!!active, order_id:active?.id||null, active_order:active?{id:active.id,tracking_code:active.tracking_code,total_eur:active.total_eur,payment_status:active.payment_status,deadline:active.payment_deadline||null}:null, tracking_code:active?.tracking_code||null, amount:active?.total_eur||null, deadline:active?.payment_deadline||null, pay_methods:D.S.pay_methods, pay_info:D.S.pay_info, nib:D.S.pay_nib, ao_method:D.S.pay_ao_method, iban:D.S.pay_iban, pt_method:D.S.pay_pt_method, holder:D.S.pay_holder, whatsapp:D.S.whatsapp, whatsapp2:D.S.whatsapp2, instagram:D.S.instagram }; }
  const paymentSubmittedMatch = p.match(/^\/orders\/(\d+)\/payment-submitted$/);
  if (paymentSubmittedMatch && m === 'POST') { need('client'); const o = D.orders.find(x => x.id == paymentSubmittedMatch[1] && x.user_id === u.id); if (!o) E('Encomenda não encontrada.', 404); if (!o.tracking_code) E('O pagamento só fica disponível depois da aprovação.', 400); if (o.payment_status === 'Pago') E('Este pagamento já foi confirmado pela BENGA.', 400); if (o.payment_status === 'Comprovativo enviado' || o.payment_status === 'Comprovativo submetido' || o.payment_status === 'Em análise') E('O comprovativo deste pagamento já foi indicado. Aguarde a confirmação da BENGA.', 400); if (o.payment_deadline && Date.parse(o.payment_deadline) <= Date.now()) E('O prazo de 30 minutos para pagamento terminou. Contacte o apoio da BENGA para receber novas instruções.', 400); o.payment_status = 'Comprovativo enviado'; o.payment_submitted_at = now(); noteStaff(`Cliente ${u.name} indicou pagamento da encomenda ${o.tracking_code}. Aguarda comprovativo e confirmação.`); note(u.id, `Pagamento indicado para ${o.tracking_code}. Envia agora o comprovativo pelo WhatsApp para a equipa confirmar.`); logA(u, 'payment_submitted', `${o.tracking_code}`); return { ok: 1, whatsapp: (() => { const wa = String(D.S.whatsapp || '').replace(/\D/g, ''); const msg = `Olá BENGA ENVIOS! Já efetuei o pagamento da encomenda ${o.tracking_code}. Valor: ${Number(o.total_eur).toFixed(2)} €. Vou enviar o comprovativo para confirmação.`; return wa ? `https://wa.me/${wa}?text=${encodeURIComponent(msg)}` : null; })() }; }
  if (p === '/notifications') { need(); return D.notif.filter(n => n.user_id === u.id).slice(-100).reverse(); }
  if (p === '/support' && m === 'POST') {
    need('client'); const s = T(b.subject, 120), msg = T(b.message, 2000); if (!s || !msg) E('Preencha assunto e mensagem.');
    if (limited('sup:' + u.id, 10, 3600e3)) E('Demasiados pedidos. Tente mais tarde.', 429);
    D.support.push({ id: D.nid++, user_id: u.id, name: u.name, email: u.email, phone: u.phone, subject: s, order_code: T(b.order_code, 30), message: msg, status: 'Nova', created_at: now() });
    noteStaff(`Nova mensagem de suporte de ${u.name}: ${s}`); return ok;
  }
  if (p === '/addresses' && m === 'GET') { need('client'); return D.addr.filter(a => a.user_id === u.id); }
  if (p === '/addresses' && m === 'POST') {
    need('client'); const a = { name: T(b.name, 80), phone: T(b.phone, 30), province: T(b.province, 80), municipality: T(b.municipality, 80), address: T(b.address, 300), reference: T(b.reference, 200) };
    if (!a.name || !a.address) E('Nome e morada são obrigatórios.');
    if (D.addr.filter(x => x.user_id === u.id).length >= 30 && !b.id) E('Limite de moradas atingido.');
    if (b.is_main) D.addr.forEach(x => x.user_id === u.id && (x.is_main = 0));
    const i = D.addr.findIndex(x => x.id == b.id && x.user_id === u.id);
    if (i >= 0) Object.assign(D.addr[i], a, { is_main: b.is_main ? 1 : 0 }); else D.addr.push({ ...a, id: D.nid++, user_id: u.id, is_main: b.is_main ? 1 : 0 });
    return ok;
  }
  if (p.startsWith('/addresses/') && m === 'DELETE') { need('client'); D.addr = D.addr.filter(a => !(a.id == p.split('/')[2] && a.user_id === u.id)); return ok; }
  if (p === '/reviews/mine') { need('client'); const r = D.rev.find(r => r.user_id === u.id); return r || null; }
  if (p === '/reviews' && m === 'POST') {
    need('client'); const st = parseInt(b.stars), tx = T(b.text, 400), del = D.orders.filter(o => o.user_id === u.id && o.status === 'Entregue');
    if (!del.length) E('Só pode avaliar depois de receber uma encomenda (estado Entregue).');
    if (D.rev.some(r => r.user_id === u.id)) E('Já enviou a sua avaliação. Obrigado!');
    if (!(st >= 1 && st <= 5)) E('Escolha uma nota de 1 a 5.'); if (tx.length < 10) E('Escreva um comentário com pelo menos 10 caracteres.');
    const o = del[del.length - 1], nm = u.name.trim().split(/\s+/);
    D.rev.push({ id: D.nid++, user_id: u.id, name: nm[0] + (nm[1] ? ' ' + nm[1][0].toUpperCase() + '.' : ''), route: o.origin + ' → ' + o.destination, stars: st, text: tx, status: 'Pendente', verified: true, created_at: now() });
    note(u.id, 'Avaliação enviada — será publicada após revisão da BENGA.'); noteStaff('Nova avaliação de cliente à espera de revisão.'); logA(u, 'review', 'nova avaliação ' + st + '★'); return ok;
  }

  /* --- administração (admin / funcionário) --- */
  if (p === '/admin/stats') {
    need('admin', 'staff'); const c = s => D.orders.filter(o => o.status === s).length, g = k => Object.entries(D.orders.reduce((a, o) => { const x = k(o); a[x] = (a[x] || 0) + 1; return a; }, {})).map(([r, n]) => ({ r, n }));
    return { total: D.orders.length, pending: c('Pendente'), transit: c('Em trânsito'), delivered: c('Entregue'), clients: D.users.filter(x => x.role === 'client').length, revenue: D.orders.filter(o => o.payment_status === 'Pago').reduce((a, o) => a + o.total_eur, 0), reviews: D.rev.length, open_support: D.support.filter(x=>x.status!=='Resolvida').length, byRoute: g(o => o.origin + ' → ' + o.destination), byCargo: g(o => o.type || o.cargo_type || 'Outro'), activity: D.log.slice(-8).reverse() };
  }
  if (p === '/admin/orders' && m === 'GET') { need('admin', 'staff'); return D.orders.slice().reverse(); }
  let r = p.match(/^\/admin\/orders\/(\d+)\/(approve|refuse|status|payment)$/);
  if (r) {
    only('POST'); const a = r[2]; if (a === 'approve' || a === 'refuse') need('admin'); else need('admin', 'staff');
    const o = D.orders.find(o => o.id == r[1]); if (!o) E('Encomenda não encontrada.', 404);
    if (a === 'approve') { need('admin'); if (o.status !== 'Pendente') E('Só solicitações pendentes podem ser aprovadas.');
      if (!o.tracking_code) { const y = new Date().getFullYear(); D.seqs[y] = (D.seqs[y] || 0) + 1; o.tracking_code = `BEN-${y}-${String(D.seqs[y]).padStart(6, '0')}`; }
      o.status = 'Aprovada'; o.decided_at = now(); o.payment_deadline = plusMinutes(30); o.payment_status = 'Pendente';
      evAdd(o, 'Encomenda aprovada', T(b.notes, 300)); note(o.user_id, 'Encomenda aprovada. Código de rastreio: ' + o.tracking_code); logA(u, 'approve', `#${o.id} ${o.tracking_code}`); return { code: o.tracking_code }; }
    if (a === 'refuse') { need('admin'); if (o.status !== 'Pendente') E('Só solicitações pendentes podem ser recusadas.'); const rs = T(b.reason, 300); if (!rs) E('Indique o motivo da recusa.');
      o.status = 'Recusada'; o.refusal_reason = rs; note(o.user_id, 'Encomenda recusada. Consulte o motivo em Minhas encomendas.'); logA(u, 'refuse', `#${o.id}: ${rs}`); return ok; }
    if (a === 'status') { need('admin', 'staff'); const st = T(b.status, 40); if (!o.tracking_code || !D.S.states.split(',').includes(st)) E('Estados operacionais só após a aprovação e dentro da lista definida.');
      o.status = st; evAdd(o, st); if (D.S.notif_status !== 'não') note(o.user_id, `Encomenda ${o.tracking_code}: ${st}`); logA(u, 'status', `#${o.id} → ${st}`); return ok; }
    need('admin', 'staff'); const ps = T(b.status, 20); if (!['Pendente', 'Comprovativo enviado', 'Em análise', 'Pago', 'Cancelado'].includes(ps)) E('Estado de pagamento inválido.');
    o.payment_status = ps; if (ps === 'Pago' && D.S.notif_payment !== 'não') note(o.user_id, 'Pagamento confirmado.'); if (ps === 'Em análise') note(o.user_id, 'O comprovativo está em análise pela BENGA.'); if (ps === 'Comprovativo enviado') note(o.user_id, 'O comprovativo foi indicado. A equipa aguarda a receção/verificação no WhatsApp.'); logA(u, 'payment', `#${o.id} → ${ps}`); return ok;
  }
  const editOrder = p.match(/^\/admin\/orders\/(\d+)$/);
  if(editOrder && m==='PUT'){ need('admin'); const o=D.orders.find(o=>o.id==editOrder[1]); if(!o)E('Encomenda não encontrada.',404); if(b.total_eur!==undefined)o.total_eur=num(b.total_eur); if(b.location!==undefined)o.location=T(b.location,120); if(b.status!==undefined){const st=T(b.status,40);if(!D.S.states.split(',').includes(st))E('Estado inválido.');o.status=st;evAdd(o,st);} if(b.payment_status!==undefined){o.payment_status=T(b.payment_status,40);} o.updated_at=now(); logA(u,'order_edit','#'+o.id); note(o.user_id,`Atualização da encomenda ${o.tracking_code}: ${o.status}.`); return o; }
  if (p === '/admin/clients' && m === 'GET') { need('admin'); return D.users.filter(x => x.role === 'client').map(x => ({ ...pubUser(x), orders: D.orders.filter(o => o.user_id === x.id).length })); }
  r = p.match(/^\/admin\/clients\/(\d+)\/block$/);
  if (r) { only('POST'); need('admin'); const x = D.users.find(x => x.id == r[1] && x.role === 'client'); if (!x) E('Cliente não encontrado.', 404); x.blocked = b.blocked ? 1 : 0; if (x.blocked) killSessions(x.id); logA(u, 'block', `${x.email} → ${x.blocked ? 'bloqueado' : 'ativo'}`); return ok; }
  r = p.match(/^\/admin\/(clients|users)\/(\d+)\/reset-password$/);
  if (r) {
    only('POST'); need('admin'); const x = D.users.find(x => x.id == r[2] && (r[1] === 'clients') === (x.role === 'client')); if (!x) E('Utilizador não encontrado.', 404); if (x.id === u.id) E('Use as definições da sua conta para mudar a sua palavra-passe.');
    const pw = crypto.randomBytes(8).toString('base64').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 10); x.pw = hashPw(pw); killSessions(x.id); logA(u, 'reset_password', x.email); return { password: pw };
  }
  if (p === '/admin/settings') {
    need('admin'); if(m==='GET') return {...D.S}; only('PUT','POST');
    for(const [k,v] of Object.entries(b)){
      if(k==='pricing'){ if(!v||!v.computer||!v.android||!v.iphone||!v.playstation)E('Tabela de preços inválida.'); D.S.pricing=v; continue; }
      if(k==='addr_ao'||k==='addr_pt'||k==='pay_holder'||k==='pay_nib'||k==='pay_ao_method'||k==='pay_iban'||k==='pay_pt_method'||k==='pay_info'||k==='pay_methods'||k==='company'||k==='slogan'||k==='phone'||k==='email'||k==='whatsapp'||k==='whatsapp2'||k==='instagram'||k==='hours'){D.S[k]=T(v,k==='pay_info'?3000:500);continue;}
      if(k==='zones'){if(!Array.isArray(v))E('Zonas inválidas.');D.S.zones=v.slice(0,50);continue;}
      if(k==='states'){D.S.states=[...new Set(String(v).split(',').map(s=>T(s,40)).filter(Boolean))].join(',');continue;}
      if(k in D.S){if(typeof D.S[k]==='number')D.S[k]=num(v);else D.S[k]=T(v,500);}
    }
    logA(u,'settings','configurações alteradas'); return {...D.S};
  }
  if (p === '/admin/cargo' && m === 'POST') { need('admin'); const n = T(b.name, 60); if (!n) E('Indique o nome.'); if (!D.cargo.some(c => c.name.toLowerCase() === n.toLowerCase())) D.cargo.push({ id: D.nid++, name: n }); return ok; }
  if (p.startsWith('/admin/cargo/') && m === 'DELETE') { need('admin'); D.cargo = D.cargo.filter(c => c.id != p.split('/')[3]); return ok; }
  if (p === '/admin/audit') { need('admin', 'staff'); return D.log.slice(-300).reverse(); }
  if (p === '/admin/users' && m === 'GET') { need('admin'); return D.users.filter(x => x.role === 'admin').map(pubUser); }
  if (p === '/admin/users' && m === 'POST') { need('admin'); E('A BENGA utiliza apenas um administrador. Não é permitido criar outros administradores ou operadores.',403); }
  r = p.match(/^\/admin\/users\/(\d+)\/(role|block)$/);
  if (r) {
    only('POST'); need('admin'); const x = D.users.find(x => x.id == r[1] && x.role !== 'client'); if (!x) E('Utilizador não encontrado.', 404); if (x.id === u.id) E('Não pode alterar a sua própria conta aqui.');
    if (r[2] === 'role') { E('A conta administrativa é única e não pode ser delegada.',403); }
    else { x.blocked = b.blocked ? 1 : 0; if (x.blocked) killSessions(x.id); logA(u, 'block', `${x.email} → ${x.blocked ? 'bloqueado' : 'ativo'}`); }
    return ok;
  }
  if (p === '/admin/support' && m === 'GET') { need('admin', 'staff'); return D.support.slice().reverse(); }
  r = p.match(/^\/admin\/support\/(\d+)\/resolve$/);
  if (r) { only('POST'); need('admin', 'staff'); const x = D.support.find(s => s.id == r[1]); if (!x) E('Mensagem não encontrada.', 404); x.status = b.status === 'Nova' ? 'Nova' : 'Resolvida'; return ok; }
  if (p === '/admin/reviews' && m === 'GET') { need('admin'); return D.rev.slice().reverse(); }
  if (p === '/admin/reviews' && m === 'POST') {
    need('admin'); const st = parseInt(b.stars), tx = T(b.text, 400), nm = T(b.name, 60);
    if (!nm || !(st >= 1 && st <= 5) || tx.length < 10) E('Indique nome, nota (1–5) e comentário (mín. 10 caracteres).');
    D.rev.push({ id: D.nid++, name: nm, route: T(b.route, 60), stars: st, text: tx, status: 'Publicada', created_at: now() }); logA(u, 'review', 'avaliação adicionada manualmente'); return ok;
  }
  r = p.match(/^\/admin\/reviews\/(\d+)\/(status|delete)$/);
  if (r) {
    only('POST'); need('admin'); const x = D.rev.find(v => v.id == r[1]); if (!x) E('Avaliação não encontrada.', 404);
    if (r[2] === 'delete') D.rev = D.rev.filter(v => v !== x); else { if (!['Publicada', 'Oculta'].includes(b.status)) E('Estado inválido.'); x.status = b.status; }
    logA(u, 'review', `${r[2]} #${x.id}`); return ok;
  }
  E('Não encontrado.', 404);
}

/* ---------- HTTP ---------- */
const INDEX = path.join(__dirname, 'index.html');
let indexCache = null;
function indexData() {
  if (!indexCache || process.env.NODE_ENV !== 'production') { const raw = fs.readFileSync(INDEX); indexCache = { raw, gz: zlib.gzipSync(raw, { level: 9 }), etag: '"' + sha(raw.toString('latin1')).slice(0, 20) + '"' }; }
  return indexCache;
}
function secHeaders(req, res) {
  const g = GOOGLE_CLIENT_ID ? ' https://accounts.google.com/gsi/client' : '';
  res.setHeader('Content-Security-Policy', ["default-src 'self'", `script-src 'self' 'unsafe-inline'${g}`, `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com${GOOGLE_CLIENT_ID ? ' https://accounts.google.com/gsi/style' : ''}`, "font-src https://fonts.gstatic.com", "img-src 'self' data:", `connect-src 'self'${GOOGLE_CLIENT_ID ? ' https://accounts.google.com/gsi/' : ''}`, GOOGLE_CLIENT_ID ? "frame-src https://accounts.google.com/gsi/" : "frame-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'"].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
function send(res, status, obj, extra = {}) { const body = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(body); }
const MIME = {
  '.js':'application/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.html':'text/html; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp',
  '.svg':'image/svg+xml', '.ico':'image/x-icon', '.mp4':'video/mp4', '.webm':'video/webm', '.txt':'text/plain; charset=utf-8'
};
function servePublic(req, res, pathname) {
  if (!['GET','HEAD'].includes(req.method)) E('Método não permitido.', 405);
  let rel;
  try { rel = decodeURIComponent(pathname.slice(1)); } catch { E('Caminho inválido.', 400); }
  if (!rel || rel.includes('\\') || rel.split('/').includes('..')) E('Caminho inválido.', 400);
  const file = path.resolve(path.join(__dirname, rel));
  const publicRoot = path.resolve(__dirname);
  if (!(file === publicRoot || file.startsWith(publicRoot + path.sep))) E('Caminho inválido.', 400);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}); return res.end('Ficheiro não encontrado.'); }
  const ext = path.extname(file).toLowerCase();
  const st = fs.statSync(file);
  const baseHeaders = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.js' || ext === '.html' ? 'no-cache' : 'public, max-age=86400', 'Accept-Ranges': 'bytes' };
  const range = req.headers.range;
  if (range && (ext === '.mp4' || ext === '.webm')) {
    const m = String(range).match(/bytes=(\d*)-(\d*)/);
    if (m) {
      let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2] || 0));
      let end = m[2] ? Number(m[2]) : st.size - 1;
      start = Math.max(0, Math.min(start, st.size - 1)); end = Math.max(start, Math.min(end, st.size - 1));
      const len = end - start + 1;
      res.writeHead(206, { ...baseHeaders, 'Content-Length': len, 'Content-Range': `bytes ${start}-${end}/${st.size}` });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, {start,end}).pipe(res);
    }
  }
  res.writeHead(200, { ...baseHeaders, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}
function readBody(req, limit = 400 * 1024) {
  if (req.webRequest && !req.webRequest.bodyUsed) {
    return req.webRequest.arrayBuffer().then(buf => {
      if (buf.byteLength > limit) throw new HttpError(413, 'Pedido demasiado grande.');
      if (!buf.byteLength) return {};
      try { const j = JSON.parse(Buffer.from(buf).toString('utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; }
      catch { throw new HttpError(400, 'Pedido inválido.'); }
    });
  }
  return new Promise((resolve, reject) => { let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(new HttpError(413, 'Pedido demasiado grande.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!n) return resolve({}); try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(j && typeof j === 'object' && !Array.isArray(j) ? j : {}); } catch { reject(new HttpError(400, 'Pedido inválido.')); } });
    req.on('error', reject); });
}
async function handler(req, res) {
  if (!initPromise) initPromise = (async () => { await load(); await seedAdmin(); })();
  await initPromise;
  secHeaders(req, res);
  const url = new URL(req.url, 'http://localhost'), pathname = url.pathname;
  try {
    if (pathname.startsWith('/api/')) {
      const ip = ipOf(req); if (limited('api:' + ip, 600, 5 * 60e3)) E('Demasiados pedidos. Aguarde um momento.', 429);
      const m = req.method;
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(m)) E('Método não permitido.', 405);
      if (m !== 'GET') {
        const org = req.headers.origin; if (org) { let h = ''; try { h = new URL(org).host; } catch { } if (h !== req.headers.host) E('Origem não permitida.', 403); }
        if (req.headers['content-length'] > 0 && !String(req.headers['content-type'] || '').includes('application/json')) E('Tipo de conteúdo inválido.', 415);
      }
      const b = m === 'GET' ? {} : await readBody(req), { u, key } = sessionOf(req), ctx = { req, m, p: pathname.slice(4), b, u, key, ip, cookie: null };
      const out = await api(ctx); if (m !== 'GET') await save();
      return send(res, 200, out === undefined ? { ok: 1 } : out, ctx.cookie ? { 'Set-Cookie': ctx.cookie } : {});
    }
    if (pathname === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\n'); }
    if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (pathname === '/' || pathname === '/index.html') {
      if (req.method !== 'GET' && req.method !== 'HEAD') E('Método não permitido.', 405);
      const d = indexData(), h = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ETag: d.etag, Vary: 'Accept-Encoding' };
      if (req.headers['if-none-match'] === d.etag) { res.writeHead(304, h); return res.end(); }
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.writeHead(200, { ...h, 'Content-Encoding': 'gzip' }); return res.end(req.method === 'HEAD' ? undefined : d.gz); }
      res.writeHead(200, h); return res.end(req.method === 'HEAD' ? undefined : d.raw);
    }
    if (pathname.startsWith('/') && pathname !== '/favicon.ico') return servePublic(req, res, pathname);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Página não encontrada.');
  } catch (e) {
    if (e instanceof HttpError) { if (!res.headersSent) return send(res, e.status, { error: e.message }); return res.end(); }
    console.error('[erro]', req.method, req.url, e); if (!res.headersSent) send(res, 500, { error: 'Erro interno. Tente novamente.' }); else res.end();
  }
}

async function start() {
  await (initPromise || (initPromise = (async () => { await load(); await seedAdmin(); })()));
  const server = http.createServer(handler); server.headersTimeout = 15000; server.requestTimeout = 30000;
  server.listen(PORT, () => {
    console.log(`BENGA ENVIOS a correr em http://localhost:${PORT}`);
    if (!D.S.whatsapp) console.log('⚠  WhatsApp ainda não configurado: Painel admin → Configurações da Benga → Contactos.');
    if (!GOOGLE_CLIENT_ID) console.log('ℹ  Login com Google desativado (defina GOOGLE_CLIENT_ID para ativar).');
  });
  const bye = async () => { try { await save(); } catch { } server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
  return server;
}
module.exports = { hashPw, DB_FILE, start, handler, load, seedAdmin };
if (require.main === module) start().catch(e => { console.error(e); process.exit(1); });
