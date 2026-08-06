# olezhkas-theaters

Olezka's Theaters — a home show calendar for the family. One page where the owner
puts up shows, everyone RSVPs, and visitors can send the owner a message.

## Files

| File | What it is |
| --- | --- |
| `olezkastheaters.html` | The app, exactly as exported from the Claude artifact. Single file, no build step, no dependencies. |
| `ANALYSIS.md` | Review of that file: features, bugs, security notes, and what has to change to host it. |

## Status

Not yet a website. The file stores everything through `window.storage`, an API that
only exists inside the Claude artifact host — in a normal browser it runs but
forgets everything on reload and shares nothing between people. It also has no
`<!doctype html>` wrapper.

See [ANALYSIS.md](ANALYSIS.md) for the details and a suggested order of work.

## Running it locally

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000/olezkastheaters.html>. You can click through the
whole app; nothing will be saved.
