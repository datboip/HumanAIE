---
description: Ask the user to highlight something on the HumanAIE browser — for captchas, finding buttons, or when you're stuck
argument-hint: <what you need help with>
allowed-tools: [Bash]
---

# Ask Human for Help via HumanAIE

When you can't find something on the page, need help with a captcha, or want the user to show you where to click.

## Send the Request

```bash
curl -s -X POST http://localhost:${HUMANAIE_PORT:-3333}/waitfor-highlight -H 'Content-Type: application/json' -d "{\"message\":\"$ARGUMENTS\"}"
```

Tell the user you've asked for their help and they should look at the HumanAIE cam page.

## Wait for Response

Poll every 3 seconds:
```bash
curl -s http://localhost:${HUMANAIE_PORT:-3333}/waitfor-highlight/status
```

When `answered` is `true`:
- `points` array has the coordinates the user highlighted
- `corrections` array has any text corrections the user typed

## After Getting the Response

1. Use the coordinates to click/interact
2. Clear the highlights: `curl -s -X POST http://localhost:${HUMANAIE_PORT:-3333}/waitfor-highlight/done`
3. Check highlight history to see if this was already answered before: `curl -s "http://localhost:${HUMANAIE_PORT:-3333}/highlight-history?url=DOMAIN"`
