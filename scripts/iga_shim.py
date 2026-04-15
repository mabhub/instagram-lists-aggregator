#!/usr/bin/env python3
"""
Shim instagrapi long-vivant pour instagram-lists-aggregator.

Modes :
  serve     : lit des requêtes JSON-lines sur stdin, répond en JSON-lines sur stdout.
              Format requête  : {"id": "<str>", "cmd": "<name>", "args": {...}}
              Format réponse  : {"id": "<str>", "ok": true,  "data": ...}
                           ou : {"id": "<str>", "ok": false, "error": "<msg>", "type": "<ExcType>"}
  (legacy)  sous-commandes one-shot (list-collections, list-shortcodes,
              fetch-post, refresh-metadata) — conservées pour debug.

Auth : session instagrapi persistée dans ~/.cache/iga/session-<username>.json.
"""
# stdlib
import argparse
import json
import os
import random
import re
import shutil
import signal
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

# third-party
import requests.exceptions as _rex
import urllib3.exceptions as _u3ex
from instagrapi import Client, extractors as _extractors
from instagrapi.exceptions import MediaNotFound

# --- instagrapi 2.x workaround: account without pinned broadcast channels ---
_orig_extract_broadcast_channel = _extractors.extract_broadcast_channel


def _safe_extract_broadcast_channel(data):
    if "pinned_channels_info" not in data:
        return None
    try:
        return _orig_extract_broadcast_channel(data)
    except (KeyError, TypeError):
        return None


_extractors.extract_broadcast_channel = _safe_extract_broadcast_channel

# --- Net retry ---
_TRANSIENT_NET_ERRORS = (
    _rex.ReadTimeout,
    _rex.ConnectionError,
    _rex.ChunkedEncodingError,
    _u3ex.ReadTimeoutError,
    _u3ex.ProtocolError,
    TimeoutError,
)


@contextmanager
def _hard_timeout(seconds: int, label: str):
    """Raise TimeoutError if the wrapped block runs longer than `seconds`.

    Uses SIGALRM (Unix only). The shim always runs on Linux in production,
    so this is safe. Previous alarms are restored on exit.
    """
    def _handler(signum, frame):
        raise TimeoutError(f"{label}: hard timeout after {seconds}s")
    old_handler = signal.signal(signal.SIGALRM, _handler)
    signal.alarm(seconds)
    try:
        yield
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old_handler)


def _with_net_retry(fn, *args, _label="call", **kwargs):
    # 4 attempts total: 3 with exponential backoff, then a final attempt
    # wrapped in a hard wall-clock timeout so a silent half-open socket
    # can't hang the whole shim.
    backoff = [5, 15, 30]
    for wait in backoff:
        try:
            return fn(*args, **kwargs)
        except _TRANSIENT_NET_ERRORS as e:
            sleep_s = wait + random.uniform(0, 3)
            print(f"{_label}: transient {type(e).__name__}, retry in {sleep_s:.1f}s",
                  file=sys.stderr)
            time.sleep(sleep_s)
    with _hard_timeout(120, _label):
        return fn(*args, **kwargs)


# --- Auth ---
CACHE = Path.home() / ".cache" / "iga"


def _read_password(username: str) -> str:
    pw = os.environ.get("IGA_PASSWORD")
    if pw:
        return pw
    import getpass
    return getpass.getpass(f"Instagram password for @{username}: ")


def _prompt_stderr(msg: str) -> str:
    sys.stderr.write(msg)
    sys.stderr.flush()
    return sys.stdin.readline().rstrip("\n")


def build_client(username: str) -> Client:
    CACHE.mkdir(parents=True, exist_ok=True)
    session_path = CACHE / f"session-{username}.json"

    def _configure(c: Client) -> Client:
        c.delay_range = [0.5, 2]
        c.request_timeout = 30
        return c

    cl = _configure(Client())

    if session_path.exists():
        try:
            cl.load_settings(session_path)
            cl.get_timeline_feed()
            print(f"Reusing cached session for @{username}", file=sys.stderr)
            return cl
        except Exception as e:
            print(f"Cached session invalid ({type(e).__name__}), re-login",
                  file=sys.stderr)
            cl = _configure(Client())

    password = _read_password(username)
    verification_code = os.environ.get("IGA_2FA_CODE", "")

    def _attempt(code: str = ""):
        if code:
            return cl.login(username, password, verification_code=code)
        return cl.login(username, password)

    try:
        _attempt(verification_code)
    except Exception as e:
        msg = f"{type(e).__name__}: {e}"
        if any(k in msg.lower() for k in ("two_factor", "2fa", "twofactor", "verification")):
            code = _prompt_stderr("2FA code for Instagram: ")
            _attempt(code)
        else:
            raise
    cl.dump_settings(session_path)
    print(f"Logged in as @{username}", file=sys.stderr)
    return cl


# --- Metadata extraction ---
_HASHTAG_RE = re.compile(r"#([\w\u00C0-\u024F]+)", re.UNICODE)
_MENTION_RE = re.compile(r"@([\w.]+)", re.UNICODE)


def _extract_location(media) -> dict | None:
    loc = getattr(media, "location", None)
    if not loc:
        return None
    return {
        "name": getattr(loc, "name", None),
        "lat": getattr(loc, "lat", None),
        "lng": getattr(loc, "lng", None),
    }


def _media_type_label(media) -> str:
    if media.media_type == 8:
        return "carousel"
    if media.media_type == 2:
        return "video"
    return "image"


def media_to_metadata(media, list_name: str | None, media_files: list[dict]) -> dict:
    caption = media.caption_text or ""
    alt_texts = []
    if media.media_type == 8 and media.resources:
        for r in media.resources:
            alt = getattr(r, "accessibility_caption", None)
            if alt:
                alt_texts.append(alt)
    else:
        alt = getattr(media, "accessibility_caption", None)
        if alt:
            alt_texts.append(alt)
    return {
        "shortcode": media.code,
        "url": f"https://www.instagram.com/p/{media.code}/",
        "type": _media_type_label(media),
        "author": {
            "username": media.user.username,
            "full_name": media.user.full_name,
            "id": str(media.user.pk),
        },
        "published_at": media.taken_at.isoformat() if media.taken_at else None,
        "caption": caption,
        "hashtags": _HASHTAG_RE.findall(caption),
        "mentions": _MENTION_RE.findall(caption),
        "alt_texts": alt_texts,
        "location": _extract_location(media),
        "media": media_files,
        "stats": {
            "likes": media.like_count,
            "views": getattr(media, "view_count", None) or getattr(media, "play_count", None),
            "comments": media.comment_count,
        },
        "list": list_name,
    }


# --- Downloads ---
def _download_media(cl: Client, media, out_dir: Path) -> list[dict]:
    out_dir.mkdir(parents=True, exist_ok=True)
    files: list[dict] = []
    idx = 1

    def _move(src: Path, typ: str):
        nonlocal idx
        dest = out_dir / f"media_{idx}{src.suffix.lower()}"
        shutil.move(str(src), dest)
        files.append({"file": dest.name, "type": typ})
        idx += 1

    # Download into a tempdir first, then move — no partial media_*.* ever visible.
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        if media.media_type == 8:  # album
            for i, r in enumerate(media.resources, 1):
                if r.media_type == 2:
                    p = _with_net_retry(cl.video_download_by_url, r.video_url,
                                        folder=tmp_path,
                                        _label=f"{media.code} video[{i}]")
                    _move(Path(p), "video")
                else:
                    p = _with_net_retry(cl.photo_download_by_url, r.thumbnail_url,
                                        folder=tmp_path,
                                        _label=f"{media.code} image[{i}]")
                    _move(Path(p), "image")
        elif media.media_type == 2:
            p = _with_net_retry(cl.video_download_by_url, media.video_url,
                                folder=tmp_path, _label=f"{media.code} video")
            _move(Path(p), "video")
        else:
            p = _with_net_retry(cl.photo_download_by_url, media.thumbnail_url,
                                folder=tmp_path, _label=f"{media.code} image")
            _move(Path(p), "image")
    return files


def _media_from_shortcode(cl: Client, shortcode: str):
    pk = _with_net_retry(cl.media_pk_from_code, shortcode,
                         _label=f"pk {shortcode}")
    return _with_net_retry(cl.media_info, pk, _label=f"info {shortcode}")


# --- Command handlers (work for both serve mode and CLI mode) ---
def do_list_collections(cl: Client) -> list[dict]:
    cols = _with_net_retry(cl.collections, _label="collections")
    # Skip auto-collections whose ids aren't numeric (ALL_MEDIA_AUTO_COLLECTION, etc.).
    out = []
    for c in cols:
        cid = str(c.id)
        if not cid.isdigit():
            continue
        out.append({"name": c.name, "id": cid})
    return out


def do_list_shortcodes(cl: Client, collection_id: str) -> list[str]:
    medias = _with_net_retry(cl.collection_medias, int(collection_id), amount=0,
                             _label=f"collection {collection_id}")
    return [m.code for m in medias]


def do_fetch_post(cl: Client, shortcode: str, output_dir: str,
                  list_name: str | None) -> dict:
    try:
        media = _media_from_shortcode(cl, shortcode)
    except MediaNotFound:
        raise RuntimeError(f"Media {shortcode} not found")
    files = _download_media(cl, media, Path(output_dir))
    return media_to_metadata(media, list_name, files)


def do_refresh_metadata(cl: Client, shortcode: str,
                        list_name: str | None) -> dict:
    media = _media_from_shortcode(cl, shortcode)
    return media_to_metadata(media, list_name, [])


_DISPATCH = {
    "list-collections": lambda cl, a: do_list_collections(cl),
    "list-shortcodes":  lambda cl, a: do_list_shortcodes(cl, a["collection_id"]),
    "fetch-post":       lambda cl, a: do_fetch_post(cl, a["shortcode"],
                                                    a["output_dir"],
                                                    a.get("list_name")),
    "refresh-metadata": lambda cl, a: do_refresh_metadata(cl, a["shortcode"],
                                                          a.get("list_name")),
}


# --- Serve mode ---
def cmd_serve(args):
    cl = build_client(args.username)
    print("READY", file=sys.stderr, flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = None
        try:
            req = json.loads(line)
            req_id = req.get("id", "")
            cmd = req["cmd"]
            handler = _DISPATCH.get(cmd)
            if handler is None:
                raise ValueError(f"Unknown cmd: {cmd}")
            data = handler(cl, req.get("args", {}))
            sys.stdout.write(json.dumps({"id": req_id, "ok": True, "data": data}) + "\n")
        except Exception as e:
            sys.stdout.write(json.dumps({
                "id": req.get("id", "") if isinstance(req, dict) else "",
                "ok": False,
                "error": str(e),
                "type": type(e).__name__,
            }) + "\n")
        sys.stdout.flush()


# --- One-shot CLI (debug) ---
def cmd_list_collections(args):
    print(json.dumps(do_list_collections(build_client(args.username))))


def cmd_list_shortcodes(args):
    print(json.dumps(do_list_shortcodes(build_client(args.username),
                                        args.collection_id)))


def cmd_fetch_post(args):
    print(json.dumps(do_fetch_post(build_client(args.username),
                                   args.shortcode, args.output_dir,
                                   args.list_name)))


def cmd_refresh_metadata(args):
    print(json.dumps(do_refresh_metadata(build_client(args.username),
                                         args.shortcode, args.list_name)))


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    ps = sub.add_parser("serve")
    ps.add_argument("--username", required=True)
    ps.set_defaults(func=cmd_serve)

    p1 = sub.add_parser("list-collections")
    p1.add_argument("--username", required=True)
    p1.set_defaults(func=cmd_list_collections)

    p2 = sub.add_parser("list-shortcodes")
    p2.add_argument("--username", required=True)
    p2.add_argument("--collection-id", required=True)
    p2.set_defaults(func=cmd_list_shortcodes)

    p3 = sub.add_parser("fetch-post")
    p3.add_argument("--username", required=True)
    p3.add_argument("--shortcode", required=True)
    p3.add_argument("--output-dir", required=True)
    p3.add_argument("--list-name", default=None)
    p3.set_defaults(func=cmd_fetch_post)

    p4 = sub.add_parser("refresh-metadata")
    p4.add_argument("--username", required=True)
    p4.add_argument("--shortcode", required=True)
    p4.add_argument("--list-name", default=None)
    p4.set_defaults(func=cmd_refresh_metadata)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
