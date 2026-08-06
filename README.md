# olezhkas-theaters

Olezka's Theaters — a home show calendar for the family. One page where the owner
puts up shows, everyone RSVPs, and visitors can send the owner a message.

Built to run on Netlify: a static page plus one small function.

## What is here

| Path | What it is |
| --- | --- |
| `public/index.html` | The whole app. One file, no build step, no framework. |
| `netlify/functions/api.mjs` | The back office: signing in, and every read and write of shared data. |
| `netlify.toml` | Publish directory, function directory, a few headers. |
| `ANALYSIS.md` | Review of the app: features, bugs, security notes. |

## How the data is split

| What | Where it lives | Who sees it |
| --- | --- | --- |
| Shows, messages, theatre name | Netlify Blobs, behind `/api` | signed-in family only |
| The two passcodes | Netlify Blobs, salted + hashed | nobody, including us |
| Chosen colour, your sign-in token | `localStorage` | just that browser |

That split is deliberate: the calendar has to be the same for the whole family,
but the colour is meant to be personal, and signing in on the tablet should not
sign anyone out on the phone.

## Signing in

Nothing shared can be read or written without a token, and the browser is never
told the passcodes.

1. You type a name and a passcode. They go to `POST /api/login`.
2. The function compares the code against a PBKDF2 hash — the codes are never
   stored in the clear, so even someone reading the blob store cannot recover
   them.
3. It returns a token: your name and role, signed with HMAC-SHA256. Changing a
   single character of it makes it invalid, so nobody can promote themselves to
   owner.
4. Every later call carries that token. The function checks it, and checks the
   role: only the owner can change the calendar, the inbox or the passcodes.
   The token lasts 30 days.

Two things are deliberately not simple writes: an RSVP goes through
`POST /api/rsvp`, which changes only *your* reply on the server, and a message
goes through `POST /api/message`, which appends. So a visitor can reply and can
write to the owner, but cannot rewrite the calendar or wipe the inbox.

The signing key comes from the `THEATER_SECRET` environment variable if you set
one. If you don't, the function makes one on first use and keeps it in the blob
store, so a fresh deploy needs no configuration. Setting `THEATER_SECRET` (Site
configuration → Environment variables) is still worth doing: changing it signs
everyone out, which is how you evict a device you no longer trust.

---

## Hosting it on Netlify

You need a Netlify account (the free tier is enough) and this repo on GitHub.
Nothing else — no database to create, no keys to paste. Netlify Blobs is
provisioned automatically the first time the function writes.

### The short way: connect the repo

1. Go to <https://app.netlify.com> and sign in with GitHub.
2. **Add new site → Import an existing project → GitHub**, and pick
   `Sklavit/olezhkas-theaters`.
3. When it asks for build settings, **leave them empty** and let `netlify.toml`
   answer. It should show:
   - Build command: *(blank)*
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
4. Pick the branch to deploy — `main` once this work is merged.
5. **Deploy site.** First build takes about a minute (it runs `npm install` for
   the function's one dependency).
6. Open the URL it gives you, something like
   `https://cheerful-mochi-1a2b3c.netlify.app`.

From then on, every push to that branch redeploys automatically.

### Rename it

**Site configuration → General → Site details → Change site name.** Pick
something the family can type: `olezkas-theaters.netlify.app`.

### Check the function came up

```sh
curl -X POST https://YOUR-SITE.netlify.app/api/hello
curl https://YOUR-SITE.netlify.app/api/data
```

- `{"needsSetup":true,...}` then `{"error":"sign in again"}` — exactly right. The
  first call is the only thing an unauthenticated caller is allowed to learn; the
  second shows the data is shut.
- `404` — the function did not deploy. Check **Deploys → the latest deploy →
  Functions** and confirm `api` is listed.

### The bit not to forget: claim the theatre

The first person to open the site gets the setup screen and chooses both
passcodes — for **anyone** who opens it. So open it yourself, right after the
first deploy, and set them before sharing the link.

If someone beats you to it, or you want to start over:
**Site configuration → Blobs**, delete the `theater` store, and reload the page.

### The other way: from your machine

```sh
npm install -g netlify-cli
netlify login
netlify init      # link this repo to a new or existing site
netlify deploy --prod
```

### Running it locally

```sh
npm install
netlify dev
```

Serves the page and the function together at <http://localhost:8888>, with blobs
stored in a local sandbox, so you can experiment without touching the family's
real calendar.

Opening `public/index.html` straight from the file system will *not* work
properly — there is no `/api/storage` there, so the app will show "The doors are
stuck".

---

## Things to know before sharing the link

- **Pick a passcode worth having.** Everything now rests on it. The function
  pauses before answering a wrong one, but that is a speed bump, not rate
  limiting — a four-digit code is still guessable by someone patient. A couple of
  words is plenty and no harder for a child to remember.
- **A token is as good as the passcode for 30 days.** It sits in `localStorage`
  on whatever device signed in. If a device is lost, change the passcodes — or
  change `THEATER_SECRET`, which signs out everyone at once.
- **Anyone can still learn the theatre's name** from `/api/hello`. That is all an
  unauthenticated caller can get; `noindex` is set so search engines stay away.
- **The page does not refresh itself.** It loads everything once when opened. If
  Dad adds a show while your tab is open, you will not see it until you reload.
  Worse, saving from a stale tab can overwrite what someone else added in the
  meantime — see §4.1 of [ANALYSIS.md](ANALYSIS.md). This is the first thing worth
  fixing next.
- **Free tier limits** are far above what a family calendar needs: 125k function
  calls a month, and the whole dataset is a few kilobytes.
