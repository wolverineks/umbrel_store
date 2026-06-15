#!/usr/bin/env python3
import base64
import html
import json
import os
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

INDEX_PATH = os.environ.get("OP_RETURN_INDEX_PATH", "/data/op_return_index.json")
SCAN_BUDGET_SECONDS = float(os.environ.get("SCAN_BUDGET_SECONDS", "8"))


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


def latest_block_header():
    block_hash = bitcoin_rpc("getbestblockhash")
    return bitcoin_rpc("getblockheader", [block_hash, True])


def has_op_return_output(vout):
    script = vout.get("scriptPubKey", {})
    if script.get("type") == "nulldata":
        return True
    asm = script.get("asm", "")
    return asm.startswith("OP_RETURN")


def load_index():
    if not os.path.isfile(INDEX_PATH):
        return None
    with open(INDEX_PATH, encoding="utf-8") as index_file:
        return json.load(index_file)


def save_index(index):
    os.makedirs(os.path.dirname(INDEX_PATH), exist_ok=True)
    temp_path = f"{INDEX_PATH}.tmp"
    with open(temp_path, "w", encoding="utf-8") as index_file:
        json.dump(index, index_file, indent=2)
        index_file.write("\n")
    os.replace(temp_path, INDEX_PATH)


def ensure_index(chain, tip_height):
    index = load_index()
    if index and index.get("chain") == chain:
        return index

    return {
        "chain": chain,
        "tip_height": tip_height,
        "last_scanned_height": -1,
        "txids": [],
    }


def scan_block_for_op_return(height):
    block_hash = bitcoin_rpc("getblockhash", [height])
    block = bitcoin_rpc("getblock", [block_hash, 2], timeout=120)
    txids = []
    for tx in block.get("tx", []):
        if any(has_op_return_output(vout) for vout in tx.get("vout", [])):
            txids.append(tx["txid"])
    return txids


def advance_index(index):
    chain_info = bitcoin_rpc("getblockchaininfo")
    chain = chain_info.get("chain", "unknown")
    tip_height = int(chain_info["blocks"])

    if index.get("chain") != chain:
        index = ensure_index(chain, tip_height)

    index["tip_height"] = tip_height
    next_height = index["last_scanned_height"] + 1
    if next_height > tip_height:
        index["complete"] = True
        return index

    index["complete"] = False
    deadline = time.monotonic() + SCAN_BUDGET_SECONDS
    blocks_scanned = 0

    while next_height <= tip_height and time.monotonic() < deadline:
        txids = scan_block_for_op_return(next_height)
        if txids:
            index["txids"].extend(txids)
        index["last_scanned_height"] = next_height
        next_height += 1
        blocks_scanned += 1

    index["blocks_scanned_this_request"] = blocks_scanned
    index["complete"] = index["last_scanned_height"] >= tip_height
    return index


def render_page(header, index, error=None, status=None):
    header_json = html.escape(json.dumps(header, indent=2)) if header else ""
    error_text = html.escape(error) if error else ""
    status_json = html.escape(json.dumps(status or {}, indent=2))
    txids = index.get("txids", [])
    txid_lines = "\n".join(html.escape(txid) for txid in txids)
    progress = (
        f"Scanned through block {index.get('last_scanned_height', -1)} "
        f"of {index.get('tip_height', '?')} "
        f"({len(txids)} OP_RETURN transactions found)"
    )
    if index.get("complete"):
        progress += " — scan complete."
    else:
        progress += " — scan in progress, refreshing every 5 seconds."

    refresh_tag = "" if index.get("complete") else '<meta http-equiv="refresh" content="5">'

    error_block = f'<p class="error">{error_text}</p><pre>{status_json}</pre>' if error else ""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  {refresh_tag}
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
    <h2>OP_RETURN transactions</h2>
    <p>{html.escape(progress)}</p>
    <div class="txids">{txid_lines}</div>
  </main>
</body>
</html>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        status = connection_status()
        try:
            header = latest_block_header()
            chain_info = bitcoin_rpc("getblockchaininfo")
            index = ensure_index(chain_info.get("chain", "unknown"), int(chain_info["blocks"]))
            index = advance_index(index)
            save_index(index)
            page = render_page(header=header, index=index, status=status)
            code = 200
        except (urllib.error.URLError, RuntimeError, KeyError, OSError, ValueError) as exc:
            index = load_index() or {
                "chain": "unknown",
                "tip_height": 0,
                "last_scanned_height": -1,
                "txids": [],
                "complete": False,
            }
            page = render_page(header=None, index=index, error=str(exc), status=status)
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