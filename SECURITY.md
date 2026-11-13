# Security

## How aia-studio is meant to run

aia-studio is a **local tool**. The editor's dev server and its document API (`npm run dev`) listen on `localhost`
only, and the MCP server (`mcp/server.js`) talks to your AI client over stdio. Neither has authentication, because
both assume that only you, on your own machine, can reach them.

Keep it that way:

- **Don't expose the dev server to a network** (`--host`, a tunnel, a public machine). Anyone who can reach it can
  read, change and delete the documents in `documents/`.
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
