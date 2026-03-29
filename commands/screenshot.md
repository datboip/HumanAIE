---
description: Take a screenshot of the current HumanAIE browser page
allowed-tools: [Bash, Read]
---

# Screenshot HumanAIE Browser

Take a screenshot of whatever the shared browser is showing.

```bash
curl -s http://localhost:${HUMANAIE_PORT:-3333}/screenshot > /tmp/humanaie-screenshot.json
```

Read the JSON response — it contains a base64 screenshot and the current URL.

Save the screenshot to a file if needed:
```bash
python3 -c "import json; open('/tmp/humanaie-screen.jpg','wb').write(__import__('base64').b64decode(json.load(open('/tmp/humanaie-screenshot.json'))['screenshot']))"
```

Then read the image at /tmp/humanaie-screen.jpg to analyze it.
