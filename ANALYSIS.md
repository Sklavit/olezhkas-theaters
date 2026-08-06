# Analysis — `public/index.html`

Review of the file as first committed (883 lines, verbatim from the Claude
artifact). Purpose: work out what it is, what it does well, and what has to change
before it can live on the web as our home website.

> **Status.** §2 is done — the file is now a proper HTML document, `window.storage`
> has been replaced with a Netlify Blobs backend, and the app is deployable (see
> [README.md](README.md)). §3 and §4 still stand, except where marked.

---

## 1. What it is

A single-file family show calendar. No build step, no dependencies, no
framework — plain CSS + ~450 lines of vanilla JS that re-renders the whole page
from a single `state` object into `<div id="app">`.

**Feature set**

| Area | What it does |
| --- | --- |
| First run | Setup screen: theatre name + two passcodes (owner / family) |
| Login | Name + passcode; the passcode decides role (`admin` or `visitor`) |
| Calendar | Monday-first month grid, prev/today/next, per-day show list, "Coming up" (next 3) |
| Shows | Owner can add / edit / delete, plus "Later 1 hr" and "Later 1 day" nudge buttons |
| RSVP | Everyone: Going / Maybe / Can't come, with a live tally per show |
| Messages | Visitors send to the owner; owner has an inbox with unread badge, mark-read, delete |
| Theme | Four background themes (red / black / yellow / orange), stored **per person** |

**Design.** Genuinely nice. Theatre-marquee header with animated bulbs, ticket-stub
cards with a dashed tear line, serif display + monospace labels, a paint-splash SVG
button for the colour picker. It looks like a thing someone cared about, not a
template.

---

## 2. The blocker: it is not a website yet — *fixed*

> Both problems below are resolved. `load()`/`save()` keep their two-argument
> shape; `shared:true` now goes to `/api/storage` (Netlify Blobs) and
> `shared:false` to `localStorage`, which maps cleanly onto the original intent.
> The file is wrapped in a real document, so it renders in standards mode. A new
> "The doors are stuck" screen covers the case the artifact never had to handle:
> the server being unreachable, which must not be mistaken for a brand-new
> theatre — otherwise an outage would show a stranger the setup screen and let
> them reset the passcodes. Kept below as the record of why.

Two things stop this file from working if we just drop it on a server.

### 2.1 `window.storage` does not exist in a browser

Every read and write goes through the Claude artifact shared-storage API:

```js
await window.storage.get(key, shared)     // load()  — line 279
await window.storage.set(key, ..., shared) // save() — line 285
```

That API is provided by the artifact host, not by browsers. On a normal page
`window.storage` is `undefined`, so:

- `load()` throws, is caught, and returns the fallback → the app always boots empty
  and shows the **setup screen** to every visitor, every time.
- `save()` throws, is caught, flips `state.storageOK = false`, and shows
  *"Saving is not working right now."*

The app still *runs* — you can click through the whole thing — but it forgets
everything on reload, and nothing is shared between people. Which is the entire
point of the app.

The `shared` boolean is the second argument, and the split is deliberate and worth
preserving in any replacement:

| Key | Shared? | Meaning |
| --- | --- | --- |
| `theater:settings` | yes | theatre name + both passcodes |
| `theater:shows` | yes | the calendar |
| `theater:messages` | yes | the inbox |
| `theater:theme` | **no** | each person picks their own colour |
| `theater:session` | **no** | who is logged in on this device |

**Options for replacing it**, cheapest first:

1. **`localStorage` shim** — ~15 lines, zero infrastructure. Persistence works, but
   "shared" becomes per-device: everyone gets their own private calendar. Good
   enough to demo, not good enough to use.
2. **Static host + tiny key-value backend** (Cloudflare Worker + KV, Deno Deploy,
   Supabase). Keeps the file static, gives real sharing. Roughly 30 lines of Worker
   for a `GET/PUT /kv/:key`. This is the recommendation.
3. **Firebase / Supabase realtime** — also fixes the staleness problem in §4.1 for
   free, at the cost of a vendor SDK and losing the no-dependency property.

### 2.2 There is no HTML skeleton

The file starts at `<meta charset="utf-8">` — no `<!doctype html>`, `<html>`,
`<head>` or `<body>`. The artifact host wraps it. Served raw, browsers fall back to
**quirks mode**. Grid and flexbox still work, so it mostly looks right, but we are
one CSS edit away from a surprise. Wrapping it in a proper document (and adding a
favicon, `<meta name="description">`, and an `apple-mobile-web-app` tag for the
kids' iPads) is a five-minute job that should happen before anything else.

---

## 3. Security — fine for family, do not oversell it

The file's own copy is honest about this ("it is not bank-level security"), and
that framing is right. Stated plainly:

- Both passcodes are stored **in plaintext** in shared storage. Anyone who can read
  shared storage has both of them.
- The settings page used to render the live codes into `<input value=...>`, putting
  them in the page source for anyone looking over the owner's shoulder. Fixed: the
  fields are now blank `type="password"` inputs, and an empty box means "keep the
  current code". The codes are no longer written into the DOM anywhere.
- The `admin` / `visitor` split is **client-side only**. A visitor who opens
  devtools and sets `state.user.role = 'admin'` gets every owner button. With a
  real backend, writes to `theater:shows` would need server-side checking, or we
  accept that any family member can edit the calendar.
- **XSS is handled properly.** `esc()` (line 297) escapes `& < > " '` and is applied
  consistently to every user-supplied string — titles, notes, place, names, message
  bodies, theatre name — in both text and attribute positions. The `data-id`
  attributes carry only `uid()` output. I did not find an injection path.

Verdict: acceptable for a household. Do not put anything on this page you would
mind a house guest reading.

---

## 4. Bugs found

### 4.1 Stale state clobbers other people's writes — *the real one*

State is loaded once in `boot()` and never refreshed. There is no polling, no
visibility-change reload, no realtime channel. Every save writes the whole array
back as one JSON blob, so **last write wins over data the writer never saw**:

- Admin opens the inbox at 9:00. A visitor sends a message at 9:05. Admin clicks
  "Mark read" at 9:10 → `save(K.messages, state.messages)` writes the 9:00 array →
  **the 9:05 message is deleted.** (lines 836, 842)
- Same shape for `saveshow`, `nudge` and `del` on the shows array.

The `rsvp` handler is the only one that gets this right — it re-reads before
mutating (line 799), with a comment explaining why. That fix should be applied to
the other five handlers, or better, replaced with per-record writes once there is a
backend.

### 4.2 A toast timeout wipes what you are typing

`toast()` sets a 2.4s timer that calls `render()`, and `render()` replaces
`app.innerHTML` wholesale. So if a toast is still counting down when you start
typing — into the add-show modal, or the message textarea — the page rebuilds from
`state` and **your draft is gone**. Reproduce: nudge a show (toast appears), click
"Add a show", start typing the title, wait for the toast to fade.

Fix: read live input values into `state` before re-render, or make the toast its
own DOM node that does not go through `render()`.

### 4.3 RSVPs are keyed by typed name

`show.rsvps[state.user.name]` — the name is free text at login with no uniqueness
check. Two people who both type "Sasha" share one RSVP slot and overwrite each
other. Also, "Sasha" and "sasha" are two different guests.

### 4.4 Smaller things

- **`upcoming()`** filters `s.date >= today`, so a show that finished this morning
  still sits in "Coming up" until midnight.
- **No reply path.** Visitors send messages into a void — the owner can read and
  delete, but cannot answer. For a family app this is the most obvious missing
  feature.
- **Nudge has no undo.** One stray tap on "Later 1 day" and the only way back is to
  open Change and retype the date.
- **Deleting a show keeps its RSVPs** — irrelevant, since the show is gone, but
  worth knowing the data is not cleaned up.

---

## 5. What holds up well

Worth saying explicitly, because these are the parts not to break:

- **Accessibility is above average for a hobby project.** `aria-selected` on tabs,
  `aria-pressed` on RSVP pills and swatches, descriptive `aria-label` on every
  calendar day ("Wed 12 Aug, 2 shows"), `role="dialog"` + `aria-modal`, Escape
  closes the modal, visible `:focus-visible` outlines, and a full
  `prefers-reduced-motion` block that kills the bulb animation.
- **Mobile.** A real 620px breakpoint that restacks the ticket stub, shrinks day
  cells and bumps small buttons to a 40px touch target.
- **Input hygiene.** `maxlength` on every field, sensible defaults (17:00, "Living
  room"), inline validation messages, `white-space:pre-wrap` so multi-line notes
  survive.
- **The writing.** "Who's arriving?", "Nothing on this day", "Opening the doors…" —
  the copy is written for the family, not for a developer.

---

## 6. Suggested order of work

1. Wrap in a real HTML document (doctype, `<head>`, title, favicon, meta).
2. Add a storage adapter behind the existing `load()` / `save()` signatures — start
   with `localStorage` so the app persists at all, keeping the same two-argument
   shape so the backend swap is a one-file change later.
3. Ship it on GitHub Pages to get a URL the family can open.
4. Put a real shared backend behind the adapter (Cloudflare Worker + KV) so the
   calendar is actually shared.
5. Fix §4.1 (re-read before write) and §4.2 (toast must not re-render).
6. Then features: owner replies to messages, undo on nudge, recurring shows.

Steps 1–2 are small and unblock everything else.
