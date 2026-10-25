---
description: Start the local documentation viewer with rendered Mermaid diagrams
allowed-tools: Bash(python3 -m http.server:*), Bash(lsof:*), Bash(curl:*)
---

Start the local docs viewer and tell the user where to open it.

1. Check whether port 8099 is already serving:

```
curl -s -o /dev/null -w "%{http_code}" http://localhost:8099/docs/viewer.html
```

If it returns 200, the viewer is already running: skip to step 3.

2. Start it in the background from the repository root:

```
python3 -m http.server 8099
```

3. Report the URL: `http://localhost:8099/docs/viewer.html`

In Claude Code, prefer the `docs` configuration in `.claude/launch.json`, which opens it in the
browser pane instead of an external browser.

The viewer reads files from disk on every load, so a refresh always shows what is currently
saved. It renders every Mermaid block in `docs/architecture.md`, and strips YAML frontmatter
from the agent definitions so they read as plain documents.

To stop it, kill the process holding the port:

```
lsof -ti:8099 | xargs kill
```
