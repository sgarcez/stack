# Stack

A lightweight web client for [Miniflux](https://miniflux.app). Single Go binary with embedded frontend.

## Features

- Three-panel layout (sidebar, entry list, article reader)
- Mobile responsive (single-panel with slide navigation)
- Keyboard navigation (`j`/`k` for next/previous article)
- Multi-user auth via Miniflux username/password
- Themeable via CSS (ships with `default` and `dark`)
- Sessions persist across restarts (encrypted cookies)

<img width="1434" height="578" alt="Screenshot 2026-06-04 at 11 36 57" src="https://github.com/user-attachments/assets/3edcd19e-74f2-4d8f-a355-1a75caddd254" />

## Quick Start

```bash
cp .env.example .env
# Edit .env with your Miniflux URL and a secret key
task dev
```

Open http://localhost:8080 and sign in with your Miniflux credentials.

## Configuration

All configuration is via environment variables (or `.env` file):

| Variable | Required | Description |
|---|---|---|
| `MINIFLUX_URL` | Yes | URL of your Miniflux instance |
| `STACK_PORT` | No | Listen port. Defaults to `8080` |
| `STACK_SECRET` | No | 32 hex chars for cookie encryption. If unset, sessions are lost on restart |
| `STACK_THEME` | No | Theme name (`default`, `dark`). Defaults to `default` |

Generate a secret:
```bash
python3 -c "import secrets; print(secrets.token_hex(16))"
```

## Docker

```bash
docker build -t stack .
docker run -p 8080:8080 \
  -e MINIFLUX_URL=https://rss.example.com/ \
  -e STACK_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(16))") \
  stack
```

## Taskfile

Requires [Task](https://taskfile.dev).

| Command | Description |
|---|---|
| `task dev` | Run with `go run` |
| `task build` | Compile to `./stack` |
| `task build-and-run` | Build then run |

## Themes

Themes live in `themes/` as CSS files. Set `STACK_THEME` to the filename (without `.css`). Each theme defines CSS custom properties (colors, fonts) and can include `@font-face` declarations referencing fonts in `themes/fonts/`.

## Project Structure

```
├── main.go              # Go backend (API proxy + embedded frontend)
├── frontend/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── themes/
│   ├── default.css
│   ├── dark.css
│   └── fonts/
├── Dockerfile
├── Taskfile.yml
└── .env.example
```
