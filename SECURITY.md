# Security

## How aia-studio is meant to run

aia-studio is a **local tool**. Its server listens on your own machine only: `localhost` in development
(`npm run dev`) and `127.0.0.1` in the desktop app. It has no authentication, because it assumes that only you, on
your own machine, can reach it.

What it does to keep web pages out (`server/guard.js`, in both the dev server and the desktop app):

- it refuses any `Host` that is not `127.0.0.1`, `localhost` or `[::1]` (DNS rebinding), and
- it refuses requests that a page of another site sends through your browser (a foreign `Origin` or
  `Sec-Fetch-Site: cross-site`).

Other programs running on your computer can still reach it, like any local server.

Keep it that way:

- **Don't expose the server to a network** (`--host`, a tunnel, a public machine). Anyone who can reach it could read,
  change and delete your documents.
- **The AI acts with your file permissions.** Once the `aia` CLI and MCP exist, they will write in your documents
  folder. Only connect AI clients you trust.
- **Documents and images are data from whoever made them.** Open documents and SVG files from people you trust.

## Reporting a vulnerability

Please report security problems **privately** through
[GitHub's private vulnerability reporting](https://github.com/pederseo-dev/aia-studio/security/advisories/new),
not in a public issue. Include what you found, how to reproduce it and what it affects.

You'll get an answer as soon as possible. Once a fix is ready it will be released and the report published, with
credit to you if you want it.

## Supported versions

aia-studio is in early development (0.x). Only the latest commit gets security fixes.
