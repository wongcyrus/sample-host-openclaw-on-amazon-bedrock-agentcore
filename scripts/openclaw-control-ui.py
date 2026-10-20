#!/usr/bin/env python3
"""Local-only relay for the actual dev runtime's bundled OpenClaw Control UI."""

import argparse
import asyncio
import base64
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sys
import time
from urllib.parse import quote, urlencode, unquote, urlsplit

import aiohttp
from aiohttp import web
import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.config import Config
from botocore.exceptions import ClientError, ConnectionClosedError, ConnectTimeoutError, EndpointConnectionError, ReadTimeoutError
from yarl import URL


ORIGIN = "http://127.0.0.1:18795"
HEADER = "X-Amzn-Bedrock-AgentCore-Runtime-Custom-Control-UI"
START = '{"type":"openclaw-control-ui-start"}'
COOKIE = "openclaw_dev_relay"
MAX_BYTES = 8 * 1024 * 1024
TRANSPORT_ERRORS = (ConnectionClosedError, ConnectTimeoutError, EndpointConnectionError, ReadTimeoutError)
UI_ROUTES = json.loads((Path(__file__).resolve().parents[1] / "bridge/control-ui-routes.json").read_text())
STATIC_PATH = re.compile(
    r"/(?:favicon(?:\.ico|\.svg|-32\.png)|apple-touch-icon\.png|manifest\.webmanifest|sw\.js|"
    r"(?:assets|fonts|themes|app-art|cloud-provider-icons|community-art|file-icons|provider-icons)/[A-Za-z0-9_./-]+)\Z")


def control_ui_path(path):
    if len(path) > 4096 or not path.startswith("/") or "//" in path or re.search(r"[\\#\s?]", path):
        return None
    try:
        segments = [unquote(part, errors="strict") for part in path.split("/")]
    except UnicodeError:
        return None
    catalog_url = bool(re.fullmatch(r"/__openclaw__/catalog-icon/[^/]+", path))
    if re.search(r"%(?![0-9a-fA-F]{2})", path) or any(
        part in (".", "..") or re.search(r"[\\\x00-\x20\x7f]", part) or (
            "/" in part and not (catalog_url and index == 3)) for index, part in enumerate(segments)
    ):
        return None
    if catalog_url:
        try:
            url = urlsplit(segments[3])
            if url.scheme != "https" or not url.hostname or url.username or url.password or url.fragment:
                return None
        except ValueError:
            return None
    normalized = path.rstrip("/") or "/"
    spa = normalized in UI_ROUTES["spaPaths"] or any(path.startswith(p) for p in UI_ROUTES["spaPrefixes"])
    config = path in UI_ROUTES["configPaths"]
    static = bool(STATIC_PATH.fullmatch(path)) or (
        path.startswith("/__openclaw__/") and bool(STATIC_PATH.fullmatch(path[13:])))
    avatar = bool(re.fullmatch(r"/avatar/[^/]+", path))
    user_avatar = bool(re.fullmatch(r"/api/users/[^/]+/avatar", path))
    resource = re.fullmatch(r"/__openclaw__/([^/]+)/(.+)", path)
    name = resource[1] if resource else None
    native_resource = name in UI_ROUTES["resources"] and (
        len(resource[2].split("/")) == (4 if name == "plugin-theme-art" else 1)
        and all(resource[2].split("/")))
    if not any((spa, config, static, avatar, user_avatar, native_resource)):
        return None
    queries = UI_ROUTES["navigationQueries"] if spa else (
        ["v", "meta"] if avatar else ["v", "tool"] if name == "plugin-activity-icon" else ["v"])
    return {"spa": spa, "authenticated": config or avatar or user_avatar or native_resource, "queries": queries}


class RuntimeUnavailable(RuntimeError):
    pass


class Runtime:
    def __init__(self, region, actor_id):
        self.region = region
        self.actor_id = actor_id
        self.aws = boto3.Session(region_name=region)
        cf = self.aws.client("cloudformation")
        outputs = {i["OutputKey"]: i["OutputValue"] for i in
                   cf.describe_stacks(StackName="OpenClawAgentCore-dev")["Stacks"][0]["Outputs"]}
        self.arn = outputs["RuntimeArn"]
        self.qualifier = outputs["RuntimeEndpointId"]
        table = self.aws.resource("dynamodb").Table("openclaw-identity-dev")
        profile = table.get_item(Key={"PK": f"CHANNEL#{actor_id}", "SK": "PROFILE"},
                                 ConsistentRead=True).get("Item")
        if not profile:
            raise RuntimeError("No registered dev identity for this Telegram actor")
        self.user_id = profile["userId"]
        session = table.get_item(Key={"PK": f"USER#{self.user_id}", "SK": "SESSION"},
                                 ConsistentRead=True).get("Item")
        if not session:
            raise RuntimeError("No existing dev session; send a Telegram message first")
        self.session_id = session["sessionId"]
        control = self.aws.client("bedrock-agentcore-control")
        runtime = control.get_agent_runtime(agentRuntimeId=self.arn.rsplit("/", 1)[1])
        env = runtime.get("environmentVariables", {})
        if env.get("OPENCLAW_ENVIRONMENT") != "dev" or env.get("OPENCLAW_CONTROL_UI") != "1":
            raise RuntimeError("Selected runtime does not enable dev Control UI")
        self.token = self.aws.client("secretsmanager").get_secret_value(
            SecretId=env["GATEWAY_TOKEN_SECRET_ID"])["SecretString"]
        self.client = self.aws.client("bedrock-agentcore", config=Config(
            connect_timeout=5, read_timeout=30, retries={"max_attempts": 0}))
        self.device_client = self.aws.client("bedrock-agentcore", config=Config(
            connect_timeout=5, read_timeout=75, retries={"max_attempts": 0}))

    def invoke(self, action, **kwargs):
        client = self.device_client if action == "control_ui_devices" else self.client
        try:
            return self._invoke(client, action, **kwargs)
        except TRANSPORT_ERRORS as error:
            raise RuntimeUnavailable(
                "Dev runtime connection timed out or disconnected. Retry the page or command; "
                "the existing session ID is unchanged. Device approval is never retried automatically."
            ) from error
        except ClientError as error:
            if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") in (409, 429, 500, 502, 503, 504):
                raise RuntimeUnavailable("Dev runtime is temporarily unavailable; retry shortly.") from error
            raise RuntimeError("AWS rejected the dev runtime request; check your credentials and IAM access.") from error

    def _invoke(self, client, action, **kwargs):
        response = client.invoke_agent_runtime(
            agentRuntimeArn=self.arn, qualifier=self.qualifier,
            runtimeSessionId=self.session_id,
            payload=json.dumps({"action": action, "userId": self.user_id,
                                "origin": ORIGIN, **kwargs}).encode(),
            contentType="application/json", accept="application/json")
        body = response["response"]
        try:
            result = json.loads(body.read())
        finally:
            body.close()
        if result.get("error"):
            raise RuntimeError(result["error"])
        return result

    def ensure_ready(self):
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            try:
                status = json.loads(self.invoke("status")["response"])
                if status.get("currentUserId") not in (None, self.user_id):
                    raise RuntimeError("Runtime owner differs from the selected identity")
                if status.get("openclawReady") and status.get("proxyReady"):
                    probe = self.invoke("control_ui_http", path="/")
                    if probe.get("status") != 200 or "body" not in probe:
                        raise RuntimeError("Existing container predates Control UI; gracefully refresh only "
                                           "this session after checking its task status and backup")
                    return
                self.invoke("warmup", actorId=self.actor_id, channel="telegram")
            except RuntimeUnavailable:
                # Provisioning and normal session replacement can outlast an HTTP
                # request. Retry only readiness, never a pairing approval.
                pass
            time.sleep(3)
        raise RuntimeUnavailable("Existing session did not become ready within four minutes. "
                                 "Retry shortly and check dev runtime logs; no session was stopped.")

    def signed_websocket(self):
        url = (f"https://bedrock-agentcore.{self.region}.amazonaws.com/runtimes/"
               f"{quote(self.arn, safe='')}/ws?qualifier={quote(self.qualifier, safe='')}")
        headers = {
            "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": self.session_id,
            HEADER: json.dumps({"userId": self.user_id, "origin": ORIGIN}, separators=(",", ":")),
        }
        credentials = self.aws.get_credentials()
        if credentials is None:
            raise RuntimeError("AWS credentials unavailable")
        request = AWSRequest(method="GET", url=url, headers=headers)
        SigV4Auth(credentials.get_frozen_credentials(), "bedrock-agentcore", self.region).add_auth(request)
        return url.replace("https://", "wss://", 1), dict(request.headers)


class Relay:
    def __init__(self, runtime):
        self.runtime = runtime
        self.login_secret = secrets.token_urlsafe(32)
        self.cookie_secret = secrets.token_urlsafe(32)
        self.sockets = set()
        self.ready_lock = asyncio.Lock()
        self.ready_task = None
        self.ready_until = 0
        self.navigations = {}
        self.navigation_targets = {}

    def navigation_url(self, path="/", query=()):
        now = time.monotonic()
        self.navigations = {key: record for key, record in self.navigations.items() if record[0] > now}
        if len(self.navigations) >= 128:
            self.navigations.clear()
        nonce = secrets.token_urlsafe(24)
        self.navigations[nonce] = (now + 60, path)
        return path + "?" + urlencode([*query, ("relay-navigation", nonce)]) + "#token=" + quote(self.runtime.token, safe="")

    async def navigation(self, request):
        self.authorize(request)
        nonce = request.match_info["nonce"]
        expiry, path = self.navigations.get(nonce, (0, None))
        if expiry <= time.monotonic() or path is None:
            raise web.HTTPGone(text="Navigation expired; reopen the requested Control UI page")
        target = self.navigation_targets.get(nonce)
        if not target:
            raise web.HTTPGone()
        script_nonce = secrets.token_urlsafe(24)
        # HTTP never receives fragments. This isolated redirect document merges
        # native UI state in the browser without altering the bundled UI.
        script = (
            "const target=new URL(" + json.dumps(target).replace("<", "\\u003c") + ",location.origin);"
            "const fragment=new URLSearchParams(location.hash.slice(1));"
            "for(const key of ['gatewayUrl','password','bootstrapToken','bootstrapProfile'])fragment.delete(key);"
            "fragment.set('token'," + json.dumps(self.runtime.token).replace("<", "\\u003c") + ");"
            "target.hash=fragment.toString();location.replace(target.href);"
        )
        return web.Response(text=f'<!doctype html><meta charset="utf-8"><title>Opening Control UI</title>'
                            f'<script nonce="{script_nonce}">{script}</script>',
                            content_type="text/html", headers={
                                "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
                                "Content-Security-Policy": f"default-src 'none'; script-src 'nonce-{script_nonce}'; "
                                                          "base-uri 'none'; frame-ancestors 'none'",
                                "X-Content-Type-Options": "nosniff",
                            })

    async def ensure_ready(self):
        async with self.ready_lock:
            if time.monotonic() < self.ready_until:
                return
            if self.ready_task is None or self.ready_task.done():
                self.ready_task = asyncio.create_task(asyncio.to_thread(self.runtime.ensure_ready))
                self.ready_task.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
            task = self.ready_task
        # Keep a single readiness check running if a browser request gives up.
        # Otherwise refreshes queue behind a slow AWS call indefinitely.
        await asyncio.wait_for(asyncio.shield(task), timeout=30)
        self.ready_until = time.monotonic() + 10

    def authorize(self, request):
        if request.host != "127.0.0.1:18795":
            raise web.HTTPForbidden(text="Invalid localhost Host")
        if request.headers.get("Origin") not in (None, ORIGIN):
            raise web.HTTPForbidden(text="Invalid localhost Origin")
        if request.headers.get("Sec-Fetch-Site") in ("cross-site", "same-site"):
            raise web.HTTPForbidden(text="Cross-site relay access denied")
        if not hmac.compare_digest(request.cookies.get(COOKIE, ""), self.cookie_secret):
            raise web.HTTPForbidden(text="Open the private login URL printed by the relay")

    async def login(self, request):
        if request.host != "127.0.0.1:18795" or request.headers.get("Origin") not in (None, ORIGIN):
            raise web.HTTPForbidden()
        if not hmac.compare_digest(request.match_info["secret"], self.login_secret):
            raise web.HTTPForbidden()
        response = web.HTTPFound(self.navigation_url())
        response.set_cookie(COOKIE, self.cookie_secret, httponly=True, samesite="Strict")
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    async def handle(self, request):
        self.authorize(request)
        if request.method not in ("GET", "HEAD"):
            raise web.HTTPMethodNotAllowed(request.method, ["GET", "HEAD"])
        if request.headers.get("Upgrade", "").lower() == "websocket":
            if request.method != "GET":
                raise web.HTTPMethodNotAllowed(request.method, ["GET"])
            if request.headers.get("Origin") != ORIGIN or request.path not in ("/", "/ws"):
                raise web.HTTPForbidden(text="WebSocket requires the exact localhost origin")
            return await self.websocket(request)
        path = getattr(request, "raw_path", request.path).split("?", 1)[0]
        route = control_ui_path(path)
        if route is None:
            raise web.HTTPNotFound(text="Unsupported Control UI route")
        query = getattr(request, "query", {})
        safe_query = []
        for key in route["queries"]:
            values = query.getall(key, []) if hasattr(query, "getall") else ([query[key]] if key in query else [])
            if len(values) > 1 or any(len(value) > 512 or re.search(r"[\x00-\x1f\x7f]", value) for value in values):
                raise web.HTTPBadRequest(text="Invalid Control UI query")
            safe_query.extend((key, value) for value in values)
        if route["spa"]:
            if request.method == "GET" and request.headers.get("Sec-Fetch-Mode") == "navigate":
                nonce = request.query.get("relay-navigation", "")
                expiry, target = self.navigations.pop(nonce, (0, None))
                if expiry <= time.monotonic() or target != path:
                    target_url = self.navigation_url(path, safe_query)
                    new_nonce = target_url.split("relay-navigation=", 1)[1].split("#", 1)[0]
                    self.navigation_targets = {
                        key: target for key, target in self.navigation_targets.items()
                        if key in self.navigations
                    }
                    self.navigation_targets[new_nonce] = target_url.split("#", 1)[0]
                    # No fragment in Location: browsers retain the incoming hash.
                    response = web.HTTPFound("/relay-navigation/" + new_nonce)
                    response.headers["Cache-Control"] = "no-store"
                    response.headers["Referrer-Policy"] = "no-referrer"
                    return response
            await self.ensure_ready()
        kwargs = {"path": path + ("?" + urlencode(safe_query) if safe_query else "")}
        if request.method == "HEAD":
            kwargs["method"] = "HEAD"
        if route["authenticated"] and request.headers.get("Authorization"):
            kwargs["authorization"] = request.headers["Authorization"]
        elif route["authenticated"]:
            kwargs["authorization"] = "Bearer " + self.runtime.token
        result = await asyncio.to_thread(self.runtime.invoke, "control_ui_http", **kwargs)
        headers = {**result["headers"], "Cache-Control": "no-store",
                   "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff"}
        return web.Response(status=result["status"], headers=headers,
                            body=base64.b64decode(result["body"], validate=True))

    async def websocket(self, request):
        await self.ensure_ready()
        url, headers = await asyncio.to_thread(self.runtime.signed_websocket)
        remote = await request.app["http"].ws_connect(
            URL(url, encoded=True), headers=headers, max_msg_size=MAX_BYTES, heartbeat=30,
            autoclose=False, timeout=aiohttp.ClientWSTimeout(ws_close=10))
        local = web.WebSocketResponse(max_msg_size=MAX_BYTES, heartbeat=30, autoclose=False)
        try:
            await remote.send_str(START)
            await local.prepare(request)
        except BaseException:
            await remote.close()
            raise
        self.sockets.update((local, remote))

        async def pump(source, target):
            while True:
                message = await source.receive()
                if message.type == aiohttp.WSMsgType.TEXT:
                    await target.send_str(message.data)
                elif message.type == aiohttp.WSMsgType.BINARY:
                    await target.send_bytes(message.data)
                elif message.type == aiohttp.WSMsgType.CLOSE:
                    code = message.data
                    code = code if code not in (1005, 1006, 1015) else 1011
                    reason = (message.extra or "").encode()[:123]
                    await target.close(code=code, message=reason)
                    await source.close(code=code, message=reason)
                    return
                elif message.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED,
                                      aiohttp.WSMsgType.CLOSING):
                    break
            code = source.close_code or 1011
            await target.close(code=code if code not in (1005, 1006, 1015) else 1011)

        tasks = [asyncio.create_task(pump(local, remote)), asyncio.create_task(pump(remote, local))]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await asyncio.gather(local.close(), remote.close())
            self.sockets.difference_update((local, remote))
        return local

    def application(self):
        @web.middleware
        async def runtime_errors(request, handler):
            try:
                return await handler(request)
            except (TimeoutError, RuntimeUnavailable, aiohttp.ClientError):
                self.ready_until = 0
                return web.Response(status=503, text=(
                    "Dev OpenClaw is starting or its AWS connection is temporarily unavailable. "
                    "Wait briefly, then reload this page. The relay is still running; "
                    "no session was stopped and no browser was approved."
                ), headers={"Retry-After": "5", "Cache-Control": "no-store",
                            "Referrer-Policy": "no-referrer"})
            except RuntimeError:
                self.ready_until = 0
                return web.Response(status=502, text=(
                    "The dev runtime could not serve this Control UI request. Check the dev "
                    "runtime logs and relay configuration, then reload. No device was approved."
                ), headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})

        app = web.Application(client_max_size=MAX_BYTES, middlewares=[runtime_errors])
        app.router.add_get("/relay-login/{secret}", self.login)
        app.router.add_get("/relay-navigation/{nonce}", self.navigation)
        app.router.add_route("*", "/{path:.*}", self.handle)

        async def clients(app):
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=90)) as client:
                app["http"] = client
                yield

        async def shutdown(app):
            await asyncio.gather(*(ws.close(code=1001) for ws in self.sockets))

        app.cleanup_ctx.append(clients)
        app.on_shutdown.append(shutdown)
        return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--actor-id", help="Existing telegram:<id>; defaults to .env.dev admin")
    parser.add_argument("--devices", action="store_true", help="List pending devices; never approves")
    parser.add_argument("--approve", metavar="REQUEST_ID", help="Explicitly approve this reviewed request")
    args = parser.parse_args()
    if os.environ.get("OPENCLAW_ENV_SUFFIX") != "dev":
        parser.error("Use ./scripts/openclaw-control-ui.sh to load and validate .env.dev")
    actor = args.actor_id or "telegram:" + os.environ.get("TELEGRAM_ADMIN_USER_ID", "").split(",")[0].strip()
    if not actor.startswith("telegram:") or not actor[9:].isdigit():
        parser.error("Provide a registered Telegram actor or set TELEGRAM_ADMIN_USER_ID in .env.dev")
    if args.devices and args.approve:
        parser.error("--devices and --approve are mutually exclusive")
    runtime = Runtime(os.environ["CDK_DEFAULT_REGION"], actor)
    if args.devices or args.approve:
        runtime.ensure_ready()
        reply = runtime.invoke("control_ui_devices",
                               command="approve" if args.approve else "list", requestId=args.approve)
        # Device tokens belong to the browser, not terminal logs.
        def redact(value):
            if isinstance(value, dict):
                return {k: ("<redacted>" if k.lower() in ("token", "tokens") else redact(v))
                        for k, v in value.items()}
            if isinstance(value, list):
                return [redact(v) for v in value]
            return value
        print(json.dumps(redact(reply), indent=2))
        return
    relay = Relay(runtime)
    print(f"Existing dev user: {runtime.user_id}; session: {runtime.session_id}", flush=True)
    print(f"Open locally: {ORIGIN}/relay-login/{relay.login_secret}", flush=True)
    print("Pairing is REQUIRED. Review: ./scripts/openclaw-control-ui.sh --devices\n"
          "Approve only the reviewed request: ./scripts/openclaw-control-ui.sh --approve REQUEST_ID",
          flush=True)
    web.run_app(relay.application(), host="127.0.0.1", port=18795, access_log=None, print=None)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, *TRANSPORT_ERRORS, ClientError) as error:
        message = str(error) if isinstance(error, RuntimeError) else (
            "AWS connection failed; check dev credentials/network and retry. No automatic approval retry."
        )
        print(f"Control UI: {message}", file=sys.stderr)
        sys.exit(1)
