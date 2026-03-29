---
description: Click at coordinates on the HumanAIE browser page
argument-hint: <x> <y>
allowed-tools: [Bash]
---

# Click in HumanAIE Browser

Click at specific coordinates. Viewport is 1280x720.

Parse the arguments as x and y coordinates, then:

```bash
curl -s -X POST http://localhost:${HUMANAIE_PORT:-3333}/live/click -H 'Content-Type: application/json' -d "{\"x\":X,\"y\":Y}"
```

Replace X and Y with the parsed coordinates from the arguments.
