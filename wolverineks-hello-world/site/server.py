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


def is_op_return_output(vout):
    script = vout.get("scriptPubKey", {})
    if script.get("type") == "nulldata":
        return True
    asm = script.get("asm", "")
    return asm.startswith("OP_RETURN")


def extract_op_returns(tx):
    outputs = []
    for vout in tx.get("vout", []):
        if not is_op_return_output(vout):
            continue
        script = vout.get("scriptPubKey", {})
        outputs.append(
            {
                "vout": vout.get("n"),
                "value": vout.get("value", 0),
                "asm": script.get("asm", ""),
                "hex": script.get("hex", ""),
            }
        )
    return outputs


def latest_block_op_return_transactions():
    block_hash = bitcoin_rpc("getbestblockhash")
    block = bitcoin_rpc("getblock", [block_hash, 2], timeout=120)
    transactions = []
    for tx in block.get("tx", []):
        op_returns = extract_op_returns(tx)
        if op_returns:
            transactions.append({"txid": tx["txid"], "op_returns": op_returns})
    return {
        "height": block.get("height"),
        "transactions": transactions,
    }


def render_op_return_output(output):
    return (
        f"<div class=\"op-return\">"
        f"<div><span class=\"label\">vout</span> {html.escape(str(output['vout']))}</div>"
        f"<div><span class=\"label\">asm</span> {html.escape(output['asm'])}</div>"
        f"<div><span class=\"label\">hex</span> {html.escape(output['hex'])}</div>"
        f"</div>"
    )


def render_transactions(transactions):
    if not transactions:
        return '<p class="empty">No OP_RETURN transactions in the latest block.</p>'

    items = []
    for tx in transactions:
        op_return_html = "".join(render_op_return_output(output) for output in tx["op_returns"])
        items.append(
            f"<details class=\"tx\">"
            f"<summary>{html.escape(tx['txid'])}</summary>"
            f"<div class=\"op-returns\">{op_return_html}</div>"
            f"</details>"
        )
    return "\n".join(items)


def render_page(block_data, error=None, status=None):
    error_text = html.escape(error) if error else ""
    status_json = html.escape(json.dumps(status or {}, indent=2))
    tx_count = len(block_data.get("transactions", []))
    summary = (
        f"{tx_count} OP_RETURN transaction(s) in the latest block "
        f"(height {block_data.get('height', '?')})"
    )
    transactions_html = render_transactions(block_data.get("transactions", []))
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
    h1 {{ margin: 0 0 0.75rem; }}
    p {{ margin: 0 0 1rem; color: #cbd5e1; }}
    .tx {{
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 0.75rem;
      background: rgba(0, 0, 0, 0.2);
      margin-bottom: 0.75rem;
      overflow: hidden;
    }}
    .tx summary {{
      cursor: pointer;
      padding: 0.9rem 1rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.85rem;
      word-break: break-all;
      list-style: none;
    }}
    .tx summary::-webkit-details-marker {{
      display: none;
    }}
    .tx summary::before {{
      content: "▸ ";
      color: #93c5fd;
    }}
    .tx[open] summary::before {{
      content: "▾ ";
    }}
    .op-returns {{
      padding: 0 1rem 1rem;
      display: grid;
      gap: 0.75rem;
    }}
    .op-return {{
      padding: 0.85rem 1rem;
      border-radius: 0.65rem;
      background: rgba(0, 0, 0, 0.35);
      font-size: 0.85rem;
      line-height: 1.6;
      word-break: break-all;
    }}
    .label {{
      color: #93c5fd;
      font-weight: 600;
      margin-right: 0.35rem;
    }}
    .empty, .error {{ color: #cbd5e1; }}
    .error {{ color: #fca5a5; margin-bottom: 1rem; }}
    pre {{
      margin: 0 0 1rem;
      padding: 1rem;
      overflow: auto;
      border-radius: 0.75rem;
      background: rgba(0, 0, 0, 0.35);
      color: #e2e8f0;
      font-size: 0.85rem;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-all;
    }}
  </style>
</head>
<body>
  <main>
    <h1>Hello, World!</h1>
    {error_block}
    <p>{html.escape(summary)}</p>
    {transactions_html}
  </main>
</body>
</html>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        status = connection_status()
        try:
            block_data = latest_block_op_return_transactions()
            page = render_page(block_data=block_data, status=status)
            code = 200
        except (urllib.error.URLError, RuntimeError, KeyError, OSError, ValueError) as exc:
            page = render_page(block_data={"height": "?", "transactions": []}, error=str(exc), status=status)
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