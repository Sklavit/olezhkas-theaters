import { getStore } from '@netlify/blobs';
import { createHmac, randomBytes, timingSafeEqual, pbkdf2Sync } from 'node:crypto';

/*
 * The theatre's back office.
 *
 * Everything shared lives here, and nothing shared leaves here without a
 * signed token. Signing in is the only unauthenticated write, and it hands
 * back a token that says who you are and what you are allowed to do:
 *
 *   POST /api/hello     -> is the theatre set up yet, and what is it called
 *   POST /api/setup     -> first run only: choose the two passcodes
 *   POST /api/login     -> name + passcode  ->  { token, role }
 *   GET  /api/data      -> the calendar (and, for the owner, the inbox)
 *   POST /api/rsvp      -> anyone: set your own reply on one show
 *   POST /api/message   -> anyone: add one message to the inbox
 *   PUT  /api/shows     -> owner only: replace the calendar
 *   PUT  /api/messages  -> owner only: replace the inbox (read / delete)
 *   PUT  /api/settings  -> owner only: rename, change passcodes
 *
 * The passcodes are never sent to a browser and never stored in the clear.
 */

const STORE = 'theater';
const K = {
  settings: 'theater:settings',
  shows:    'theater:shows',
  messages: 'theater:messages',
  secret:   'auth:secret'      // never reachable through any route
};

const TOKEN_LIFE = 30 * 24 * 60 * 60 * 1000;   // 30 days — a family, not a bank
const MAX_BYTES  = 512 * 1024;
const PBKDF2     = { iterations: 120000, keylen: 32, digest: 'sha256' };
const HOUSE      = "Olezka's Theaters";

const store = () => getStore({ name: STORE, consistency: 'strong' });

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });

const fail = (message, status) => Object.assign(new Error(message), { status });

async function readJSON(s, key, fallback){
  const raw = await s.get(key);
  if(!raw) return fallback;
  try{ return JSON.parse(raw); }catch(e){ return fallback; }
}

async function readBody(req){
  const raw = await req.text();
  if(raw.length > MAX_BYTES) throw fail('too big', 413);
  if(!raw) return {};
  try{ return JSON.parse(raw); }catch(e){ throw fail('not json', 400); }
}

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/* ---------- the signing key ----------
   Taken from THEATER_SECRET if it is set, otherwise made once and kept in
   the blob store, so a fresh deploy needs no configuration at all. */
let cachedSecret = null;
async function secret(s){
  if(cachedSecret) return cachedSecret;
  if(process.env.THEATER_SECRET){
    cachedSecret = Buffer.from(process.env.THEATER_SECRET, 'utf8');
    return cachedSecret;
  }
  const found = await s.get(K.secret);
  if(found){
    cachedSecret = Buffer.from(found, 'hex');
    return cachedSecret;
  }
  const made = randomBytes(32);
  await s.set(K.secret, made.toString('hex'));
  cachedSecret = made;
  return made;
}

/* ---------- tokens ---------- */
const b64u   = buf => Buffer.from(buf).toString('base64url');
const unb64u = s   => Buffer.from(s, 'base64url');

function sign(payload, key){
  const body = b64u(JSON.stringify(payload));
  return `${body}.${b64u(createHmac('sha256', key).update(body).digest())}`;
}

function verify(token, key){
  if(typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if(dot < 1) return null;
  const body = token.slice(0, dot);
  let given;
  try{ given = unb64u(token.slice(dot + 1)); }catch(e){ return null; }
  const want = createHmac('sha256', key).update(body).digest();
  if(given.length !== want.length || !timingSafeEqual(given, want)) return null;
  let claims;
  try{ claims = JSON.parse(unb64u(body).toString('utf8')); }catch(e){ return null; }
  if(!claims || typeof claims.exp !== 'number' || Date.now() > claims.exp) return null;
  if(claims.role !== 'admin' && claims.role !== 'visitor') return null;
  if(!claims.name) return null;
  return claims;
}

/* ---------- passcodes ---------- */
function hashCode(code, saltHex){
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : randomBytes(16);
  const dk = pbkdf2Sync(code, salt, PBKDF2.iterations, PBKDF2.keylen, PBKDF2.digest);
  return { salt: salt.toString('hex'), hash: dk.toString('hex') };
}

function codeMatches(code, rec){
  if(!rec || !rec.salt || !rec.hash || !code) return false;
  const a = Buffer.from(hashCode(code, rec.salt).hash, 'hex');
  const b = Buffer.from(rec.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/* An older deployment stored the codes in the clear. Keep those theatres
   working — and their shows, messages and name — by upgrading the record
   the first time someone signs in successfully. Nothing is discarded. */
const isLegacy = s => !!s && !s.admin && !s.visitor && (s.adminCode || s.visitorCode);

/* ---------- who is asking ---------- */
async function currentUser(req, s){
  const header = req.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const user = verify(token, await secret(s));
  if(!user) throw fail('sign in again', 401);
  return user;
}

const ownerOnly = user => {
  if(user.role !== 'admin') throw fail('only the owner can do that', 403);
};

/* ============================================================
   ROUTES
   ============================================================ */

async function hello(s){
  const settings = await readJSON(s, K.settings, null);
  return json({
    needsSetup: !settings,
    houseName: settings ? settings.houseName || HOUSE : HOUSE
  });
}

async function setup(req, s){
  if(await readJSON(s, K.settings, null)) throw fail('this theatre is already set up', 409);
  const { houseName, adminCode, visitorCode } = await readBody(req);
  const admin = str(adminCode, 24), visitor = str(visitorCode, 24);
  if(!admin || !visitor) throw fail('fill in both passcodes to continue', 400);
  if(admin === visitor) throw fail('the two passcodes need to be different', 400);
  const settings = {
    houseName: str(houseName, 34) || HOUSE,
    admin: hashCode(admin),
    visitor: hashCode(visitor)
  };
  await s.set(K.settings, JSON.stringify(settings));
  return json({ ok: true, houseName: settings.houseName });
}

async function login(req, s){
  const { name, code } = await readBody(req);
  const settings = await readJSON(s, K.settings, null);
  if(!settings) return json({ needsSetup: true }, 409);

  const who = str(name, 24);
  if(!who) throw fail('type your name first', 400);
  const given = String(code == null ? '' : code);

  let role = null, upgraded = null;
  if(isLegacy(settings)){
    if(given && given === settings.adminCode) role = 'admin';
    else if(given && given === settings.visitorCode) role = 'visitor';
    if(role){
      upgraded = {
        houseName: settings.houseName || HOUSE,
        admin: hashCode(settings.adminCode),
        visitor: hashCode(settings.visitorCode)
      };
    }
  }else{
    if(codeMatches(given, settings.admin)) role = 'admin';
    else if(codeMatches(given, settings.visitor)) role = 'visitor';
  }

  if(!role){
    // Slow down anyone working through four-digit codes. Not real rate
    // limiting — see the note in the README about picking a longer one.
    await new Promise(r => setTimeout(r, 400));
    throw fail('that passcode does not work. Try again.', 401);
  }
  if(upgraded) await s.set(K.settings, JSON.stringify(upgraded));

  const token = sign({ name: who, role, exp: Date.now() + TOKEN_LIFE }, await secret(s));
  return json({ token, name: who, role, houseName: settings.houseName || HOUSE });
}

async function data(s, user){
  const [settings, shows, messages] = await Promise.all([
    readJSON(s, K.settings, null),
    readJSON(s, K.shows, []),
    readJSON(s, K.messages, [])
  ]);
  return json({
    me: { name: user.name, role: user.role },
    houseName: (settings && settings.houseName) || HOUSE,
    shows,
    // The inbox is the owner's. Visitors are never sent it.
    messages: user.role === 'admin' ? messages : []
  });
}

async function rsvp(req, s, user){
  const { id, value } = await readBody(req);
  if(value !== null && !['yes', 'maybe', 'no'].includes(value)) throw fail('bad reply', 400);
  const shows = await readJSON(s, K.shows, []);
  const target = shows.find(x => x.id === id);
  if(!target) return json({ gone: true, shows }, 404);

  target.rsvps = target.rsvps || {};
  const had = target.rsvps[user.name];
  // Read, change and write happen here rather than in the browser, so two
  // people replying at the same time no longer overwrite each other.
  if(value === null || had === value) delete target.rsvps[user.name];
  else target.rsvps[user.name] = value;

  await s.set(K.shows, JSON.stringify(shows));
  return json({ shows, removed: had === value || value === null });
}

async function message(req, s, user){
  const { text } = await readBody(req);
  const clean = str(text, 800);
  if(!clean) throw fail('write something first', 400);
  const messages = await readJSON(s, K.messages, []);
  // Append only: a visitor can add to the inbox but never rewrite it.
  messages.push({
    id: randomBytes(5).toString('hex'),
    from: user.name,
    text: clean,
    at: Date.now(),
    read: false
  });
  await s.set(K.messages, JSON.stringify(messages));
  return json({ ok: true });
}

async function putList(req, s, user, key){
  ownerOnly(user);
  const list = await readBody(req);
  if(!Array.isArray(list)) throw fail('expected a list', 400);
  await s.set(key, JSON.stringify(list));
  return json({ ok: true });
}

async function putSettings(req, s, user){
  ownerOnly(user);
  const current = await readJSON(s, K.settings, null);
  if(!current) throw fail('this theatre is not set up yet', 409);
  const { houseName, adminCode, visitorCode } = await readBody(req);

  // Start from what is already stored, so a rename never disturbs the codes.
  const next = {
    houseName: str(houseName, 34) || current.houseName || HOUSE,
    admin:   current.admin   || (current.adminCode   ? hashCode(current.adminCode)   : null),
    visitor: current.visitor || (current.visitorCode ? hashCode(current.visitorCode) : null)
  };

  const admin = str(adminCode, 24), visitor = str(visitorCode, 24);
  if(admin && visitor && admin === visitor) throw fail('the passcodes must be different', 400);
  if(admin && !visitor && codeMatches(admin, next.visitor)) throw fail('the passcodes must be different', 400);
  if(visitor && !admin && codeMatches(visitor, next.admin)) throw fail('the passcodes must be different', 400);
  if(admin)   next.admin   = hashCode(admin);
  if(visitor) next.visitor = hashCode(visitor);
  if(!next.admin || !next.visitor) throw fail('both passcodes are needed', 400);

  await s.set(K.settings, JSON.stringify(next));
  return json({ ok: true, houseName: next.houseName });
}

/* ============================================================
   ENTRY
   ============================================================ */

export default async (req) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  const method = req.method;
  const s = store();

  try{
    if(path === '/api/hello' && method === 'POST') return await hello(s);
    if(path === '/api/setup' && method === 'POST') return await setup(req, s);
    if(path === '/api/login' && method === 'POST') return await login(req, s);

    const user = await currentUser(req, s);

    if(path === '/api/data'     && method === 'GET')  return await data(s, user);
    if(path === '/api/rsvp'     && method === 'POST') return await rsvp(req, s, user);
    if(path === '/api/message'  && method === 'POST') return await message(req, s, user);
    if(path === '/api/shows'    && method === 'PUT')  return await putList(req, s, user, K.shows);
    if(path === '/api/messages' && method === 'PUT')  return await putList(req, s, user, K.messages);
    if(path === '/api/settings' && method === 'PUT')  return await putSettings(req, s, user);

    return json({ error: 'not found' }, 404);
  }catch(e){
    if(e.status) return json({ error: e.message }, e.status);
    console.error('api failed', { path, method, message: e.message });
    return json({ error: 'something went wrong at the theatre' }, 500);
  }
};

export const config = {
  path: [
    '/api/hello', '/api/setup', '/api/login', '/api/data',
    '/api/rsvp', '/api/message', '/api/shows', '/api/messages', '/api/settings'
  ]
};
