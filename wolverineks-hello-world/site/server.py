#!/usr/bin/env python3
import base64
import html
import json
import os
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeoutError
from decimal import Decimal, ROUND_HALF_UP
from urllib.parse import parse_qs, urlencode, urlparse
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn


BLOCK_FETCH_TIMEOUT = 90
_block_fetch_executor = ThreadPoolExecutor(max_workers=4)


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

    if not isinstance(body, dict):
        raise RuntimeError(
            f"Bitcoin RPC returned unexpected JSON type: {type(body).__name__}"
        )

    if body.get("error"):
        error = body["error"]
        if isinstance(error, dict):
            raise RuntimeError(error.get("message") or json.dumps(error))
        raise RuntimeError(str(error))

    if "result" not in body:
        raise RuntimeError("Bitcoin RPC returned an unexpected response")

    return body["result"]


def btc_to_sats(value):
    return int(
        (Decimal(str(value)) * Decimal(100_000_000)).to_integral_value(rounding=ROUND_HALF_UP)
    )


def parse_pushdata(script_tail):
    chunks = []
    index = 0
    while index < len(script_tail):
        opcode = script_tail[index]
        if opcode == 0:
            index += 1
            continue
        if 1 <= opcode <= 75:
            length = opcode
            index += 1
            chunks.append(script_tail[index : index + length])
            index += length
            continue
        if opcode == 0x4C:
            length = script_tail[index + 1]
            index += 2
            chunks.append(script_tail[index : index + length])
            index += length
            continue
        if opcode == 0x4D:
            length = int.from_bytes(script_tail[index + 1 : index + 3], "little")
            index += 3
            chunks.append(script_tail[index : index + length])
            index += length
            continue
        if opcode == 0x4E:
            length = int.from_bytes(script_tail[index + 1 : index + 5], "little")
            index += 5
            chunks.append(script_tail[index : index + length])
            index += length
            continue
        chunks.append(script_tail[index:])
        break
    return chunks


def is_readable_text(text):
    return bool(text) and all(
        character.isprintable() or character in "\n\r\t" for character in text
    )


def try_decode_utf8(data):
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None
    return text if is_readable_text(text) else None


def try_decode_ascii(data):
    try:
        text = data.decode("ascii")
    except UnicodeDecodeError:
        return None
    return text if is_readable_text(text) else None


def guess_protocol(data):
    if data.startswith(b"omni"):
        return "Omni Layer"
    if data.startswith(b"CNTRPRTY"):
        return "Counterparty"
    if data.startswith(b"ORD"):
        return "Ordinals / meta-protocol"
    return None


def decode_op_return_script(script_hex):
    try:
        script = bytes.fromhex(script_hex)
    except ValueError:
        return {
            "data_hex": "",
            "utf8": None,
            "ascii": None,
            "protocol": None,
            "bytes": 0,
            "error": "invalid script hex",
        }

    if not script or script[0] != 0x6A:
        return {
            "data_hex": "",
            "utf8": None,
            "ascii": None,
            "protocol": None,
            "bytes": 0,
            "error": "not an OP_RETURN script",
        }

    data = b"".join(parse_pushdata(script[1:]))
    return {
        "data_hex": data.hex(),
        "utf8": try_decode_utf8(data),
        "ascii": try_decode_ascii(data),
        "protocol": guess_protocol(data),
        "bytes": len(data),
        "error": None,
    }


def decoded_payload(value):
    return value if isinstance(value, dict) else {}


def read_varint(data, offset):
    if offset >= len(data):
        raise ValueError("unexpected end of transaction data")

    prefix = data[offset]
    if prefix < 0xFD:
        return prefix, offset + 1
    if prefix == 0xFD:
        return int.from_bytes(data[offset + 1 : offset + 3], "little"), offset + 3
    if prefix == 0xFE:
        return int.from_bytes(data[offset + 1 : offset + 5], "little"), offset + 5
    return int.from_bytes(data[offset + 1 : offset + 9], "little"), offset + 9


def skip_inputs(data, offset):
    vin_count, offset = read_varint(data, offset)
    for _ in range(vin_count):
        offset += 36
        script_len, offset = read_varint(data, offset)
        offset += script_len
        offset += 4
    return offset, vin_count


def skip_outputs(data, offset):
    vout_count, offset = read_varint(data, offset)
    for _ in range(vout_count):
        offset += 8
        script_len, offset = read_varint(data, offset)
        offset += script_len
    return offset


def skip_witness(data, offset, vin_count):
    for _ in range(vin_count):
        item_count, offset = read_varint(data, offset)
        for _ in range(item_count):
            item_len, offset = read_varint(data, offset)
            offset += item_len
    return offset


def skip_transaction_at(data, offset, assume_segwit):
    start = offset
    offset += 4
    if assume_segwit:
        if len(data) < offset + 2 or data[offset] != 0 or data[offset + 1] != 1:
            return None
        offset += 2

    try:
        offset, vin_count = skip_inputs(data, offset)
        offset = skip_outputs(data, offset)
        if assume_segwit:
            offset = skip_witness(data, offset, vin_count)
        offset += 4
        if offset > len(data):
            return None
        return start, offset
    except (IndexError, ValueError):
        return None


def skip_transaction(data, offset):
    legacy = skip_transaction_at(data, offset, assume_segwit=False)
    if legacy is not None and legacy[1] <= len(data):
        if legacy[1] == len(data):
            return legacy

    if len(data) > offset + 6 and data[offset + 4] == 0 and data[offset + 5] == 1:
        segwit = skip_transaction_at(data, offset, assume_segwit=True)
        if segwit is not None and segwit[1] == len(data):
            return segwit

    if legacy is not None:
        return legacy
    raise ValueError("unable to parse transaction size")


def iter_transactions_from_block_hex(block_hex):
    data = bytes.fromhex(block_hex)
    if len(data) < 81:
        raise RuntimeError("block hex from Bitcoin RPC is too short")

    offset = 80
    tx_count, offset = read_varint(data, offset)
    for _ in range(tx_count):
        try:
            parsed = skip_transaction(data, offset)
        except ValueError:
            break
        if parsed is None:
            break
        start, end = parsed
        if start >= end or end > len(data):
            break
        yield data[start:end].hex()
        offset = end


def parse_tx_outputs(data, assume_segwit):
    offset = 4
    if assume_segwit:
        if len(data) < 6 or data[offset] != 0 or data[offset + 1] != 1:
            return None
        offset += 2

    try:
        offset, vin_count = skip_inputs(data, offset)
        vout_count, offset = read_varint(data, offset)
        outputs = []
        for vout_index in range(vout_count):
            value = int.from_bytes(data[offset : offset + 8], "little")
            offset += 8
            script_len, offset = read_varint(data, offset)
            script = data[offset : offset + script_len]
            offset += script_len
            if not script or script[0] != 0x6A:
                continue

            decoded = decode_op_return_script(script.hex())
            outputs.append(
                {
                    "vout": vout_index,
                    "sats": value,
                    "asm": "",
                    "hex": script.hex(),
                    "decoded": decoded,
                }
            )

        if assume_segwit:
            offset = skip_witness(data, offset, vin_count)
        offset += 4
        if offset != len(data):
            return None
        return outputs
    except (IndexError, ValueError):
        return None


def scan_raw_tx_for_op_returns(tx_hex):
    data = bytes.fromhex(tx_hex)
    outputs = parse_tx_outputs(data, assume_segwit=False)
    if outputs is not None:
        return outputs

    if len(data) > 6 and data[4] == 0 and data[5] == 1:
        outputs = parse_tx_outputs(data, assume_segwit=True)
        if outputs is not None:
            return outputs

    return []


def enrich_op_return_tx(tx_hex, op_returns):
    tx = bitcoin_rpc("decoderawtransaction", [tx_hex, True], timeout=60)
    if not isinstance(tx, dict):
        raise RuntimeError("decoderawtransaction returned an unexpected response")

    op_by_vout = {item["vout"]: item for item in op_returns}
    enriched = []
    for vout in tx.get("vout", []):
        if not isinstance(vout, dict):
            continue
        vout_index = vout.get("n")
        if vout_index not in op_by_vout:
            continue
        script = vout.get("scriptPubKey", {})
        if not isinstance(script, dict):
            continue
        base = op_by_vout[vout_index]
        enriched.append(
            {
                "vout": vout_index,
                "sats": btc_to_sats(vout.get("value", 0)),
                "asm": script.get("asm", base["asm"]),
                "hex": script.get("hex", base["hex"]),
                "decoded": base["decoded"],
            }
        )

    return {"txid": tx["txid"], "op_returns": enriched}


def fetch_block(block_hash):
    for verbosity in (2, 1):
        result = bitcoin_rpc("getblock", [block_hash, verbosity], timeout=60)
        if isinstance(result, dict):
            return result

    result = bitcoin_rpc("getblock", [block_hash, 0], timeout=60)
    if isinstance(result, str):
        return {"_raw_hex": True, "height": None, "_block_hex": result}

    raise RuntimeError(
        f"Unexpected getblock response type from Bitcoin RPC: {type(result).__name__}"
    )


def normalize_block_transactions(block):
    if block.get("_raw_hex"):
        transactions = []
        for tx_hex in iter_transactions_from_block_hex(block["_block_hex"]):
            try:
                op_returns = scan_raw_tx_for_op_returns(tx_hex)
                if op_returns:
                    transactions.append(enrich_op_return_tx(tx_hex, op_returns))
            except Exception:
                continue
        return transactions

    transactions = []
    for tx in block.get("tx", []):
        if isinstance(tx, str):
            tx = bitcoin_rpc("getrawtransaction", [tx, True], timeout=60)
        if not isinstance(tx, dict):
            continue
        op_returns = extract_op_returns(tx)
        if op_returns:
            transactions.append({"txid": tx["txid"], "op_returns": op_returns})
    return transactions


def is_op_return_output(vout):
    if not isinstance(vout, dict):
        return False

    script = vout.get("scriptPubKey", {})
    if not isinstance(script, dict):
        return False
    if script.get("type") == "nulldata":
        return True
    asm = script.get("asm", "")
    return asm.startswith("OP_RETURN")


def extract_op_returns(tx):
    if not isinstance(tx, dict):
        return []

    outputs = []
    for vout in tx.get("vout", []):
        if not is_op_return_output(vout):
            continue
        script = vout.get("scriptPubKey", {})
        script_hex = script.get("hex", "")
        decoded = decode_op_return_script(script_hex)
        outputs.append(
            {
                "vout": vout.get("n"),
                "sats": btc_to_sats(vout.get("value", 0)),
                "asm": script.get("asm", ""),
                "hex": script_hex,
                "decoded": decoded,
            }
        )
    return outputs


def block_op_return_transactions_with_timeout(height=None):
    future = _block_fetch_executor.submit(block_op_return_transactions, height)
    try:
        return future.result(timeout=BLOCK_FETCH_TIMEOUT)
    except FuturesTimeoutError as exc:
        raise RuntimeError(
            f"Timed out after {BLOCK_FETCH_TIMEOUT}s while loading block data from Bitcoin RPC."
        ) from exc


def block_op_return_transactions(height=None):
    chain_info = bitcoin_rpc("getblockchaininfo")
    if not isinstance(chain_info, dict):
        raise RuntimeError("getblockchaininfo returned an unexpected response")

    tip_height = chain_info["blocks"]

    if height is None:
        target_height = tip_height
    else:
        target_height = max(0, min(int(height), tip_height))

    block_hash = bitcoin_rpc("getblockhash", [target_height])
    block = fetch_block(block_hash)
    transactions = normalize_block_transactions(block)
    return {
        "height": block.get("height", target_height),
        "tip_height": tip_height,
        "transactions": transactions,
    }


def parse_filters(path):
    query = parse_qs(urlparse(path).query)
    min_sats_raw = query.get("min_sats", ["0"])[0].strip()
    try:
        min_sats = max(0, int(min_sats_raw))
    except ValueError:
        min_sats = 0

    height_raw = query.get("height", [""])[0].strip()
    height = None
    if height_raw:
        try:
            height = int(height_raw)
        except ValueError:
            height = None

    return {
        "q": query.get("q", [""])[0].strip(),
        "protocol": query.get("protocol", ["all"])[0].strip().lower(),
        "readable": query.get("readable", [""])[0] == "1",
        "min_sats": min_sats,
        "height": height,
    }


def build_query_params(filters, height=None):
    params = {}
    if height is not None:
        params["height"] = str(height)
    if filters.get("q"):
        params["q"] = filters["q"]
    if filters.get("protocol", "all") != "all":
        params["protocol"] = filters["protocol"]
    if filters.get("readable"):
        params["readable"] = "1"
    if filters.get("min_sats", 0) > 0:
        params["min_sats"] = str(filters["min_sats"])
    return params


def build_url(filters, height=None):
    params = build_query_params(filters, height)
    if not params:
        return "/"
    return "?" + urlencode(params)


def output_search_text(output):
    decoded = decoded_payload(output.get("decoded"))
    parts = [
        output.get("asm", ""),
        output.get("hex", ""),
        str(output.get("sats", "")),
        decoded.get("data_hex", ""),
        decoded.get("ascii") or "",
        decoded.get("utf8") or "",
        decoded.get("protocol") or "",
    ]
    return " ".join(parts).lower()


def transaction_search_text(tx):
    parts = [tx["txid"], *(output_search_text(output) for output in tx["op_returns"])]
    return " ".join(parts).lower()


def output_matches_protocol(output, protocol_filter):
    protocol = decoded_payload(output.get("decoded")).get("protocol")
    if protocol_filter == "all":
        return True
    if protocol_filter == "unknown":
        return protocol is None
    if protocol_filter == "omni":
        return protocol == "Omni Layer"
    if protocol_filter == "counterparty":
        return protocol == "Counterparty"
    if protocol_filter == "ordinals":
        return protocol == "Ordinals / meta-protocol"
    return True


def transaction_has_readable_text(tx):
    for output in tx["op_returns"]:
        decoded = decoded_payload(output.get("decoded"))
        if decoded.get("ascii") is not None or decoded.get("utf8") is not None:
            return True
    return False


def transaction_matches_filters(tx, filters):
    if filters["q"] and filters["q"].lower() not in transaction_search_text(tx):
        return False

    if filters["readable"] and not transaction_has_readable_text(tx):
        return False

    if filters["min_sats"] > 0 and not any(
        output.get("sats", 0) >= filters["min_sats"] for output in tx["op_returns"]
    ):
        return False

    if filters["protocol"] != "all" and not any(
        output_matches_protocol(output, filters["protocol"]) for output in tx["op_returns"]
    ):
        return False

    return True


def filter_transactions(transactions, filters):
    return [tx for tx in transactions if transaction_matches_filters(tx, filters)]


def render_decoded_output(decoded):
    decoded = decoded_payload(decoded)
    if decoded.get("error"):
        return f"<div><span class=\"label\">decoded</span> {html.escape(decoded['error'])}</div>"

    lines = [f"<div><span class=\"label\">data bytes</span> {decoded['bytes']}</div>"]
    if decoded.get("protocol"):
        lines.append(
            f"<div><span class=\"label\">protocol</span> {html.escape(decoded['protocol'])}</div>"
        )
    if decoded.get("ascii") is not None:
        lines.append(
            f"<div><span class=\"label\">ascii</span> {html.escape(decoded['ascii'])}</div>"
        )
    if decoded.get("utf8") is not None and decoded.get("utf8") != decoded.get("ascii"):
        lines.append(
            f"<div><span class=\"label\">utf-8</span> {html.escape(decoded['utf8'])}</div>"
        )
    lines.append(
        f"<div><span class=\"label\">data hex</span> {html.escape(decoded.get('data_hex', ''))}</div>"
    )
    return "\n".join(lines)


def render_op_return_output(output):
    return (
        f"<div class=\"op-return\">"
        f"<div><span class=\"label\">vout</span> {html.escape(str(output['vout']))}</div>"
        f"<div><span class=\"label\">sats</span> {html.escape(str(output['sats']))}</div>"
        f"{render_decoded_output(output['decoded'])}"
        f"<div><span class=\"label\">asm</span> {html.escape(output['asm'])}</div>"
        f"<div><span class=\"label\">script hex</span> {html.escape(output['hex'])}</div>"
        f"</div>"
    )


def render_block_nav(block_data, filters):
    height = block_data.get("height")
    tip_height = block_data.get("tip_height")
    if height is None or tip_height is None:
        return ""

    at_tip = height >= tip_height
    prev_disabled = height <= 0
    next_disabled = at_tip

    def nav_link(label, target_height, disabled=False):
        if disabled:
            return f'<span class="nav-btn disabled">{html.escape(label)}</span>'
        return f'<a class="nav-btn" href="{html.escape(build_url(filters, target_height))}">{html.escape(label)}</a>'

    latest_label = "Latest block" if not at_tip else "Latest block (current)"
    latest_link = (
        f'<span class="nav-btn disabled">{html.escape(latest_label)}</span>'
        if at_tip
        else nav_link(latest_label, tip_height)
    )

    return f"""
    <nav class="block-nav" aria-label="Block navigation">
      {nav_link("← Previous block", height - 1, disabled=prev_disabled)}
      <span class="block-height">Block {html.escape(str(height))}</span>
      {nav_link("Next block →", height + 1, disabled=next_disabled)}
      {latest_link}
    </nav>
    """


def render_filter_form(filters):
    q = html.escape(filters["q"])
    min_sats = html.escape(str(filters["min_sats"]))
    readable_checked = " checked" if filters["readable"] else ""
    protocol = filters["protocol"]
    height = filters.get("height")
    height_field = (
        f'<input type="hidden" name="height" value="{html.escape(str(height))}">'
        if height is not None
        else ""
    )
    reset_filters = {
        "q": "",
        "protocol": "all",
        "readable": False,
        "min_sats": 0,
        "height": height,
    }
    reset_href = html.escape(build_url(reset_filters, height))

    def selected(value):
        return " selected" if protocol == value else ""

    return f"""
    <form class="filters" method="get">
      {height_field}
      <div class="filter-row">
        <label>
          <span>Search</span>
          <input type="search" name="q" value="{q}" placeholder="txid, hex, ascii, utf-8, protocol">
        </label>
        <label>
          <span>Protocol</span>
          <select name="protocol">
            <option value="all"{selected("all")}>All</option>
            <option value="unknown"{selected("unknown")}>Unknown</option>
            <option value="omni"{selected("omni")}>Omni</option>
            <option value="counterparty"{selected("counterparty")}>Counterparty</option>
            <option value="ordinals"{selected("ordinals")}>Ordinals</option>
          </select>
        </label>
      </div>
      <div class="filter-row">
        <label>
          <span>Min sats</span>
          <input type="number" name="min_sats" min="0" step="1" value="{min_sats}">
        </label>
        <label class="checkbox">
          <input type="checkbox" name="readable" value="1"{readable_checked}>
          <span>Readable text only</span>
        </label>
        <div class="filter-actions">
          <button type="submit">Apply filters</button>
          <a class="reset" href="{reset_href}">Reset</a>
        </div>
      </div>
    </form>
    """


def render_transactions(transactions, filters_active=False, block_height=None):
    if not transactions:
        block_label = f"block at height {block_height}" if block_height is not None else "this block"
        empty_message = (
            "No OP_RETURN transactions match the current filters."
            if filters_active
            else f"No OP_RETURN transactions in {block_label}."
        )
        return f'<p class="empty">{empty_message}</p>'

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


def filters_are_active(filters):
    return bool(filters["q"]) or filters["readable"] or filters["min_sats"] > 0 or filters["protocol"] != "all"


def build_block_content(block_data, filters):
    all_transactions = block_data.get("all_transactions", block_data.get("transactions", []))
    filtered_transactions = block_data.get("transactions", [])
    total_count = len(all_transactions)
    visible_count = len(filtered_transactions)
    active = filters_are_active(filters)

    height = block_data.get("height", "?")
    tip_height = block_data.get("tip_height")
    at_tip = height == tip_height if tip_height is not None else False
    block_label = f"block at height {height}" + (" (latest)" if at_tip else "")

    if active:
        summary = (
            f"Showing {visible_count} of {total_count} OP_RETURN transaction(s) in {block_label}"
        )
    else:
        summary = f"{total_count} OP_RETURN transaction(s) in {block_label}"

    return {
        "summary": summary,
        "block_nav_html": render_block_nav(block_data, filters),
        "transactions_html": render_transactions(
            filtered_transactions,
            filters_active=active,
            block_height=height if height != "?" else None,
        ),
    }


def page_styles():
    return """
    html, body {
      margin: 0;
      height: 100%;
    }
    body {
      box-sizing: border-box;
      overflow: hidden;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at top, #1f2937 0%, #0b0f17 55%, #05070b 100%);
      color: #f8fafc;
      padding: 1.5rem;
      min-height: 100vh;
      height: 100vh;
    }
    main {
      width: min(100%, 56rem);
      height: calc(100vh - 3rem);
      margin: 0 auto;
      padding: 2rem;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 1.25rem;
      background: rgba(15, 23, 42, 0.72);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
      box-sizing: border-box;
    }
    .page-header {
      flex-shrink: 0;
    }
    .tx-scroll {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding-right: 0.35rem;
      margin-top: 0.25rem;
    }
    .tx-scroll::-webkit-scrollbar {
      width: 0.55rem;
    }
    .tx-scroll::-webkit-scrollbar-thumb {
      background: rgba(148, 163, 184, 0.45);
      border-radius: 999px;
    }
    .tx-scroll::-webkit-scrollbar-track {
      background: rgba(0, 0, 0, 0.2);
      border-radius: 999px;
    }
    h1 { margin: 0 0 0.75rem; }
    p { margin: 0 0 1rem; color: #cbd5e1; }
    .summary { margin-bottom: 0.75rem; }
    .loading { color: #94a3b8; font-style: italic; }
    .filters {
      display: grid;
      gap: 0.85rem;
      margin-bottom: 1.25rem;
      padding: 1rem;
      border-radius: 0.85rem;
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .filter-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.85rem;
      align-items: end;
    }
    .filters label {
      display: grid;
      gap: 0.35rem;
      color: #cbd5e1;
      font-size: 0.85rem;
      min-width: 10rem;
      flex: 1 1 12rem;
    }
    .filters label.checkbox {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      min-height: 2.4rem;
    }
    .filters input,
    .filters select,
    .filters button {
      width: 100%;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 0.55rem;
      background: rgba(15, 23, 42, 0.9);
      color: #f8fafc;
      padding: 0.65rem 0.75rem;
      font: inherit;
    }
    .filters button {
      cursor: pointer;
      background: #2563eb;
      border-color: #2563eb;
      font-weight: 600;
    }
    .filter-actions {
      display: flex;
      gap: 0.75rem;
      align-items: center;
      margin-left: auto;
    }
    .filter-actions button {
      width: auto;
      min-width: 8rem;
    }
    .reset {
      color: #93c5fd;
      text-decoration: none;
      font-size: 0.9rem;
      white-space: nowrap;
    }
    .block-nav {
      display: flex;
      flex-wrap: wrap;
      gap: 0.65rem;
      align-items: center;
      margin-bottom: 1rem;
    }
    .nav-btn {
      display: inline-block;
      padding: 0.55rem 0.85rem;
      border-radius: 0.55rem;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(15, 23, 42, 0.9);
      color: #f8fafc;
      text-decoration: none;
      font-size: 0.9rem;
      font-weight: 600;
    }
    .nav-btn:hover {
      border-color: #2563eb;
      color: #93c5fd;
    }
    .nav-btn.disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .block-height {
      color: #cbd5e1;
      font-size: 0.95rem;
      font-weight: 600;
      margin: 0 0.25rem;
    }
    .tx {
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 0.75rem;
      background: rgba(0, 0, 0, 0.2);
      margin-bottom: 0.75rem;
      overflow: hidden;
    }
    .tx summary {
      cursor: pointer;
      padding: 0.9rem 1rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.85rem;
      word-break: break-all;
      list-style: none;
    }
    .tx summary::-webkit-details-marker {
      display: none;
    }
    .tx summary::before {
      content: "▸ ";
      color: #93c5fd;
    }
    .tx[open] summary::before {
      content: "▾ ";
    }
    .op-returns {
      padding: 0 1rem 1rem;
      display: grid;
      gap: 0.75rem;
    }
    .op-return {
      padding: 0.85rem 1rem;
      border-radius: 0.65rem;
      background: rgba(0, 0, 0, 0.35);
      font-size: 0.85rem;
      line-height: 1.6;
      word-break: break-all;
    }
    .label {
      color: #93c5fd;
      font-weight: 600;
      margin-right: 0.35rem;
    }
    .empty, .error { color: #cbd5e1; }
    .error { color: #fca5a5; margin-bottom: 1rem; }
    pre {
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
    }
    """


def render_shell(filters):
    filter_form_html = render_filter_form(filters)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hello World</title>
  <style>{page_styles()}</style>
</head>
<body>
  <main>
    <div class="page-header">
      <h1>Hello, World!</h1>
      <div id="block-nav-slot">
        <nav class="block-nav" aria-label="Block navigation">
          <span class="block-height loading">Loading block...</span>
        </nav>
      </div>
      {filter_form_html}
      <p class="summary loading">Loading block data from Bitcoin RPC...</p>
    </div>
    <div class="tx-scroll" role="region" aria-label="OP_RETURN transactions">
      <p class="loading">Loading transactions...</p>
    </div>
  </main>
  <script>
    function escapeHtml(value) {{
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }}

    async function loadBlockData() {{
      const summary = document.querySelector(".summary");
      const txScroll = document.querySelector(".tx-scroll");
      const navSlot = document.getElementById("block-nav-slot");
      try {{
        const response = await fetch("/api/block" + window.location.search);
        const data = await response.json();
        if (data.error) {{
          summary.className = "summary";
          summary.textContent = "Could not load block data.";
          if (data.block_nav_html) {{
            navSlot.innerHTML = data.block_nav_html;
          }}
          txScroll.innerHTML =
            '<p class="error">' + escapeHtml(data.error) + "</p>" +
            "<pre>" + escapeHtml(JSON.stringify(data.status || {{}}, null, 2)) + "</pre>";
          return;
        }}
        summary.className = "summary";
        summary.textContent = data.summary;
        if (data.block_nav_html) {{
          navSlot.innerHTML = data.block_nav_html;
        }}
        txScroll.innerHTML = data.transactions_html;
      }} catch (error) {{
        summary.className = "summary";
        summary.textContent = "Could not load block data.";
        txScroll.innerHTML = '<p class="error">' + escapeHtml(error) + "</p>";
      }}
    }}

    loadBlockData();
  </script>
</body>
</html>"""


def load_block_api_payload(filters):
    status = connection_status()
    try:
        block_data = block_op_return_transactions_with_timeout(filters.get("height"))
        all_transactions = block_data["transactions"]
        block_data["all_transactions"] = all_transactions
        block_data["transactions"] = filter_transactions(all_transactions, filters)
        content = build_block_content(block_data, filters)
        return 200, {"error": None, "status": status, **content}
    except Exception as exc:
        return 503, {
            "error": str(exc),
            "status": status,
            "summary": "Could not load block data.",
            "block_nav_html": "",
            "transactions_html": "",
        }


def send_text_response(handler, status_code, content_type, body):
    encoded = body.encode() if isinstance(body, str) else body
    handler.send_response(status_code)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(encoded)))
    handler.end_headers()
    try:
        handler.wfile.write(encoded)
    except (BrokenPipeError, ConnectionResetError):
        return


def send_json_response(handler, status_code, payload):
    send_text_response(
        handler,
        status_code,
        "application/json; charset=utf-8",
        json.dumps(payload),
    )


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/health", "/healthz"):
            send_text_response(self, 200, "text/plain; charset=utf-8", "ok")
            return

        filters = parse_filters(self.path)
        if path == "/api/block":
            code, payload = load_block_api_payload(filters)
            send_json_response(self, code, payload)
            return

        send_text_response(self, 200, "text/html; charset=utf-8", render_shell(filters))

    def log_message(self, format, *args):
        return


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 3000), Handler).serve_forever()