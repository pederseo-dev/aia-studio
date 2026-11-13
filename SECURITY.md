# Security

## How aia-studio is meant to run

aia-studio is a **local tool**. The editor's server and its document API listen on your own machine only: `localhost`
in development (`npm run dev`) and `127.0.0.1` in the desktop app. The MCP server (`mcp/server.js`) talks to your AI
client over stdio. Neither has authentication, because both assume that only you, on your own machine, can reach
them.

What the API does to keep web pages out: it refuses requests that a page of another site sends through your browser
(a cross-site `Origin` or `Sec-Fetch-Site`), and the desktop app's server also refuses any `Host` that is not
`127.0.0.1` or `localhost` (DNS rebinding). Other programs running on your computer can still reach it, like any
local server.

Keep it that way:

- **Don't expose the dev server to a network** (`--host`, a tunnel, a public machine). Anyone who can reach it can
  read, change and delete your documents.
- **Connect your AI writes your AI client's settings.** The Connect to Claude Desktop button only adds, updates or
  removes the `aia-studio` entry in `claude_desktop_config.json`, keeps the rest as it was and saves the previous
  file as `claude_desktop_config.json.aia-backup`. A file that isn't valid JSON is never touched.
- **The AI acts with your file permissions.** Through MCP it writes documents in `documents/`, and `add_image` can
  copy a local file you point it to or download an image from a URL. Only connect AI clients you trust, and review
  what they ask to do as you would with any other tool that touches your disk.
- **Documents and images are data from whoever made them.** Open documents and SVG files from people you trust.

## Reporting a vulnerability

Please report security problems **privately** through
[GitHub's private vulnerability reporting](https://github.com/pederseo-dev/aia-studio/security/advisories/new),
not in a public issue. Include what you found, how to reproduce it and what it affects.

You'll get an answer as soon as possible. Once a fix is ready it will be released and the report published, with
credit to you if you want it.

## Supported versions

aia-studio is in early development (0.x). Only the latest commit on `main` gets security fixes.
