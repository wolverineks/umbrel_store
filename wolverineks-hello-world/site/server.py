#!/usr/bin/env python3
import base64
import html
import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer


def bitcoin_rpc(method, params=None):
    params = params or []
    host = os.environ["BITCOIN_RPC_HOST"]
    port = os.environ["BITCOIN_RPC_PORT"]
    user = os.environ["BITCOIN_RPC_USER"]
    password = os.environ["BITCOIN_RPC_PASS"]

    payload = json.dumps(
        {"jsonrpc": "1.0", "id": "wolverineks-hello-world", "method": method, "params": params}
    ).encode()
    request = urllib.request.Request(f"http://{host}:{port}/", data=payload, method="POST")
    request.add_header("Content-Type", "application/json")
    credentials = base64.b64encode(f"{user}:{password}".encode()).decode()
    request.add_header("Authorization", f"Basic {credentials}")

    with urllib.request.urlopen(request, timeout=15) as response:
        body = json.loads(response.read())

    if body.get("error"):
        raise RuntimeError(body["error"])

    return body["result"]


def latest_block_header():
    block_hash = bitcoin_rpc("getbestblockhash")
    return bitcoin_rpc("getblockheader", [block_hash, True])


def render_page(header=None, error=None):
    header_json = html.escape(json.dumps(header, indent=2)) if header else ""
    error_text = html.escape(error) if error else ""

    if error:
        body = f'<p class="error">{error_text}</p>'
    else:
        body = f"<pre>{header_json}</pre>"

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hello World</title>
  <style>
    body {{
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at top, #1f2937 0%, #0b0f17 55%, #05070b 100%);
      color: #f8fafc;
      padding: 1.5rem;
    }}
    main {{
      width: min(96vw, 48rem);
      padding: 2rem;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 1.25rem;
      background: rgba(15, 23, 42, 0.72);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
    }}
    h1 {{ margin: 0 0 0.5rem; font-size: 2rem; }}
    p {{ margin: 0 0 1.25rem; color: #cbd5e1; }}
    pre {{
      margin: 0;
      padding: 1rem;
      overflow-x: auto;
      border-radius: 0.75rem;
      background: rgba(0, 0, 0, 0.35);
      color: #e2e8f0;
      font-size: 0.9rem;
      line-height: 1.5;
    }}
    .error {{ color: #fca5a5; }}
  </style>
</head>
<body>
  <main>
    <h1>Hello, World!</h1>
    <p>Latest Bitcoin block header from Bitcoin Core:</p>
    {body}
  </main>
</body>
</html>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            header = latest_block_header()
            page = render_page(header=header)
            status = 200
        except (urllib.error.URLError, RuntimeError, KeyError, OSError) as exc:
            page = render_page(error=str(exc))
            status = 503

        encoded = page.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format, *args):
        return


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 3000), Handler).serve_forever()