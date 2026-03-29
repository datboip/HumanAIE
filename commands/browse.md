---
description: Open a URL in the shared HumanAIE browser. The user can watch you browse in real-time and help with captchas.
argument-hint: <url>
allowed-tools: [Bash, Read, Write, WebFetch]
---

# Browse with HumanAIE

Open a URL in the shared browser so both you and the user can see it.

## Setup Check

First check if HumanAIE is running:
```bash
curl -s --max-time 3 http://localhost:${HUMANAIE_PORT:-3333}/live/status 2>/dev/null || echo "NOT_RUNNING"
```

If not running, tell the user:
"HumanAIE isn't running. Start it with: cd /path/to/HumanAIE && npm start"

## Navigate

```bash
curl -s -X POST http://localhost:${HUMANAIE_PORT:-3333}/navigate -H 'Content-Type: application/json' -d "{\"url\":\"$ARGUMENTS\"}"
```

Tell the user the browser is now showing the URL and they can watch at http://localhost:${HUMANAIE_PORT:-3333}/cam/

## If You Need Help

When you can't find a button or need the user to solve a captcha:

```bash
# Ask user to highlight something
curl -s -X POST http://localhost:${HUMANAIE_PORT:-3333}/waitfor-highlight -H 'Content-Type: application/json' -d '{"message":"DESCRIBE WHAT YOU NEED"}'
```

Then poll until they respond:
```bash
curl -s http://localhost:${HUMANAIE_PORT:-3333}/waitfor-highlight/status
```

When `answered: true`, use the coordinates from `points` to click.
