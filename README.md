# olezhkas-theaters

Olezka's Theaters — a home show calendar for the family. One page where the owner
puts up shows, everyone RSVPs, and visitors can send the owner a message.

Built to run on Netlify: a static page plus one small function.

## What is here

| Path | What it is |
| --- | --- |
| `public/index.html` | The whole app. One file, no build step, no framework. |
| `netlify/functions/storage.mjs` | Reads and writes the shared data (Netlify Blobs). |
| `netlify.toml` | Publish directory, function directory, a few headers. |
| `ANALYSIS.md` | Review of the app: features, bugs, security notes. |

## How the data is split

| What | Where it lives | Who sees it |
| --- | --- | --- |
| Shows, messages, theatre name + passcodes | Netlify Blobs, via `/api/storage` | everyone |
| Chosen colour, who is signed in on this device | `localStorage` | just that browser |

That split is deliberate: the calendar has to be the same for the whole family,
but the colour is meant to be personal, and signing in on the tablet should not
sign anyone out on the phone.

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
curl https://YOUR-SITE.netlify.app/api/storage?key=theater:shows
```

- `{"value":null}` — working, nothing saved yet. This is what you want on day one.
- `{"value":"[...]"}` — working, with shows saved.
- `404` — the function did not deploy. Check **Deploys → the latest deploy →
  Functions** and confirm `storage` is listed.

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

- **The data endpoint is open.** Anyone who knows your site URL can read or
  overwrite the calendar by calling `/api/storage` directly — including reading
  the passcodes, which are stored in plain text. The passcodes gate the *screens*,
  not the data. For a family calendar on an unlisted URL that is a reasonable
  trade; do not put anything private on the page. `noindex` is set so search
  engines stay away.
- **The page does not refresh itself.** It loads everything once when opened. If
  Dad adds a show while your tab is open, you will not see it until you reload.
  Worse, saving from a stale tab can overwrite what someone else added in the
  meantime — see §4.1 of [ANALYSIS.md](ANALYSIS.md). This is the first thing worth
  fixing next.
- **Free tier limits** are far above what a family calendar needs: 125k function
  calls a month, and the whole dataset is a few kilobytes.
