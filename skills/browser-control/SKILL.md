---
name: HumanAIE Browser Control
description: Use when browsing the web, filling forms, clicking buttons, solving captchas, or any task requiring a visible browser the user can watch and assist with. Activates when user mentions browsing, websites, signing up, captcha, login, or web research.
version: 1.0.0
---

# HumanAIE — Shared Browser for Human-AI Collaboration

You have access to a shared headless browser via HumanAIE. The user can watch everything you do in real-time and help when needed.

## API Reference (all via curl to localhost)

**Port**: Use `${HUMANAIE_PORT:-3333}`

### Navigate
```bash
curl -s -X POST http://localhost:3333/navigate -H 'Content-Type: application/json' -d '{"url":"URL"}'
```

### Click (viewport 1280x720)
```bash
curl -s -X POST http://localhost:3333/live/click -H 'Content-Type: application/json' -d '{"x":X,"y":Y}'
```

### Type text
```bash
curl -s -X POST http://localhost:3333/live/type -H 'Content-Type: application/json' -d '{"text":"hello"}'
```

### Press key
```bash
curl -s -X POST http://localhost:3333/live/key -H 'Content-Type: application/json' -d '{"key":"Enter"}'
```

### Back / Forward
```bash
curl -s -X POST http://localhost:3333/back
curl -s -X POST http://localhost:3333/forward
```

### Screenshot
```bash
curl -s http://localhost:3333/screenshot
```

### Check status
```bash
curl -s http://localhost:3333/live/status
```

## Human-in-the-Loop

### Ask user to show you where something is
```bash
curl -s -X POST http://localhost:3333/waitfor-highlight -H 'Content-Type: application/json' -d '{"message":"where is the login button?"}'
```

### Poll for their answer
```bash
curl -s http://localhost:3333/waitfor-highlight/status
# Wait for "answered": true, then read "points" for coordinates
```

### Clear after using
```bash
curl -s -X POST http://localhost:3333/waitfor-highlight/done
```

### Check history (don't ask twice for the same thing)
```bash
curl -s "http://localhost:3333/highlight-history?url=example.com"
```

## Rules

1. Always check if HumanAIE is running before using it
2. The user can see everything — don't try to hide actions
3. Before asking the user for help, check highlight history first
4. When stuck on captcha, ask the user — they can solve it from the cam page
5. Save what you learn (coordinates, workflows) so you don't ask again
