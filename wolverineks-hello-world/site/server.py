#!/usr/bin/env python3
import base64
import html
import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer


def load_rpc_credentials():
    user = os.environ.get("BITCOIN_RPC_USER", "").strip()
    password = os.environ.get("BITCOIN_RPC_PASS", "").strip()
    if user and password:
        return user, password, "env"

    cookie_path = os.environ.get("BITCOIN_COOKIE_FILE", "").strip()
    if cookie_path and os.path.isfile(cookie_path):
        with open(cookie_path, encoding="utf-8") as cookie_file:
            cookie = cookie_file.read().strip()
        if ":" in cookie:
            cookie_user, cookie_password = cookie.split(":", 1)
            return cookie_user, cookie_password, "cookie"

    return None, None, "missing"


def connection_status():
    host = os.environ.get("BITCOIN_RPC_HOST", "").strip()
    port = os.environ.get("BITCOIN_RPC_PORT", "").strip()
    _, _, auth_source = load_rpc_credentials()
    return {
        "host": host or "(not set)",
        "port": port or "(not set)",
        "auth": auth_source,
        "cookie_file": os.environ.get("BITCOIN_COOKIE_FILE", "(not set)"),
    }


def bitcoin_rpc(method, params=None, timeout=60):
    params = params or []
    host = os.environ.get("BITCOIN_RPC_HOST", "").strip()
    port = os.environ.get("BITCOIN_RPC_PORT", "").strip()
    user, password, auth_source = load_rpc_credentials()

    if not host or not port:
        raise RuntimeError(
            "Bitcoin RPC host/port not configured. Reinstall the app after Bitcoin Node is installed."
        )
    if auth_source == "missing":
        raise RuntimeError(
            "Bitcoin RPC credentials not available. Reinstall the app with Bitcoin Node installed."
        )

    payload = json.dumps(
        {"jsonrpc": "1.0", "id": "wolverineks-hello-world", "method": method, "params": params}
    ).encode()
    request = urllib.request.Request(f"http://{host}:{port}/", data=payload, method="POST")
    request.add_header("Content-Type", "application/json")
    credentials = base64.b64encode(f"{user}:{password}".encode()).decode()
    request.add_header("Authorization", f"Basic {credentials}")

    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = json.loads(response.read())

    if body.get("error"):
        raise RuntimeError(body["error"])

    return body["result"]


def has_op_return_output(vout):
    script = vout.get("scriptPubKey", {})
    if script.get("type") == "nulldata":
        return True
    asm = script.get("asm", "")
    return asm.startswith("OP_RETURN")


def latest_block_header():
    block_hash = bitcoin_rpc("getbestblockhash")
    return bitcoin_rpc("getblockheader", [block_hash, True])


def latest_block_op_return_txids():
    block_hash = bitcoin_rpc("getbestblockhash")
    block = bitcoin_rpc("getblock", [block_hash, 2], timeout=120)
    txids = []
    for tx in block.get("tx", []):
        if any(has_op_return_output(vout) for vout in tx.get("vout", [])):
            txids.append(tx["txid"])
    return txids


def render_page(header, op_return_txids, error=None, status=None):
    header_json = html.escape(json.dumps(header, indent=2)) if header else ""
    error_text = html.escape(error) if error else ""
    status_json = html.escape(json.dumps(status or {}, indent=2))
    txid_lines = "\n".join(html.escape(txid) for txid in op_return_txids)
    summary = (
        f"{len(op_return_txids)} OP_RETURN transaction(s) in the latest block "
        f"(height {header.get('height') if header else '?'})"
    )

    error_block = f'<p class="error">{error_text}</p><pre>{status_json}</pre>' if error else ""

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
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at top, #1f2937 0%, #0b0f17 55%, #05070b 100%);
      color: #f8fafc;
      padding: 1.5rem;
    }}
    main {{
      width: min(96vw, 56rem);
      margin: 0 auto;
      padding: 2rem;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 1.25rem;
      background: rgba(15, 23, 42, 0.72);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
    }}
    h1, h2 {{ margin: 0 0 0.75rem; }}
    h2 {{ font-size: 1.2rem; margin-top: 1.75rem; }}
    p {{ margin: 0 0 1rem; color: #cbd5e1; }}
    pre, .txids {{
      margin: 0;
      padding: 1rem;
      overflow: auto;
      max-height: 24rem;
      border-radius: 0.75rem;
      background: rgba(0, 0, 0, 0.35);
      color: #e2e8f0;
      font-size: 0.85rem;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-all;
    }}
    .error {{ color: #fca5a5; margin-bottom: 1rem; }}
  </style>
</head>
<body>
  <main>
    <h1>Hello, World!</h1>
    {error_block}
    <h2>Latest block header</h2>
    <pre>{header_json}</pre>
    <h2>OP_RETURN transactions in latest block</h2>
    <p>{html.escape(summary)}</p>
    <div class="txids">{txid_lines or "(none)"}</div>
  </main>
</body>
</html>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        status = connection_status()
        try:
            header = latest_block_header()
            op_return_txids = latest_block_op_return_txids()
            page = render_page(header=header, op_return_txids=op_return_txids, status=status)
            code = 200
        except (urllib.error.URLError, RuntimeError, KeyError, OSError, ValueError) as exc:
            page = render_page(header=None, op_return_txids=[], error=str(exc), status=status)
            code = 503

        encoded = page.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format, *args):
        return


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 3000), Handler).serve_forever()