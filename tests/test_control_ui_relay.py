import importlib.util
import asyncio
import io
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from aiohttp import web


def load_script():
    path = Path(__file__).resolve().parents[1] / "scripts/openclaw-control-ui.py"
    spec = importlib.util.spec_from_file_location("control_ui_relay", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_relay_rejects_foreign_hosts_origins_and_missing_cookie():
    module = load_script()
    relay = module.Relay(SimpleNamespace(token="gateway-test-token"))
    request = SimpleNamespace(host="127.0.0.1:18795", headers={},
                              cookies={module.COOKIE: relay.cookie_secret})
    relay.authorize(request)
    for host, headers, cookies in [
        ("evil.example:18795", {}, request.cookies),
        (request.host, {"Origin": "https://evil.example"}, request.cookies),
        (request.host, {"Sec-Fetch-Site": "cross-site"}, request.cookies),
        (request.host, {}, {}),
    ]:
        with pytest.raises(web.HTTPForbidden):
            relay.authorize(SimpleNamespace(host=host, headers=headers, cookies=cookies))


def test_websocket_signed_server_side_with_same_session_and_custom_route():
    module = load_script()
    runtime = module.Runtime.__new__(module.Runtime)
    runtime.region = "us-east-1"
    runtime.arn = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/dev"
    runtime.qualifier = "DEFAULT"
    runtime.user_id = "existing-user"
    runtime.session_id = "existing-session-not-replaced"
    from botocore.credentials import Credentials
    runtime.aws = SimpleNamespace(get_credentials=lambda: Credentials("TESTACCESS", "test-secret", "session"))
    url, headers = runtime.signed_websocket()
    assert url.startswith("wss://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/arn%3A")
    assert url.endswith("/ws?qualifier=DEFAULT")
    assert "Signature=" not in url and "test-secret" not in url
    assert headers["X-Amzn-Bedrock-AgentCore-Runtime-Session-Id"] == runtime.session_id
    assert json.loads(headers[module.HEADER]) == {
        "userId": "existing-user", "origin": module.ORIGIN,
    }
    assert "AWS4-HMAC-SHA256" in headers["Authorization"]
    assert str(module.URL(url, encoded=True)) == url
    assert str(module.URL(url)) != url


def test_runtime_resolves_existing_identity_and_session_and_rejects_production(monkeypatch):
    module = load_script()
    env = {"OPENCLAW_ENVIRONMENT": "dev", "OPENCLAW_CONTROL_UI": "1", "GATEWAY_TOKEN_SECRET_ID": "dev/token"}
    reads = []

    def get_item(**kwargs):
        reads.append(kwargs)
        key = kwargs["Key"]["PK"]
        return {"Item": {"userId": "owner"}} if key.startswith("CHANNEL#") else {
            "Item": {"sessionId": "existing-session"}}

    clients = {
        "cloudformation": SimpleNamespace(describe_stacks=lambda **kwargs: {"Stacks": [{"Outputs": [
            {"OutputKey": "RuntimeArn", "OutputValue": "arn:runtime/dev"},
            {"OutputKey": "RuntimeEndpointId", "OutputValue": "DEFAULT"},
        ]}]}),
        "bedrock-agentcore-control": SimpleNamespace(get_agent_runtime=lambda **kwargs: {"environmentVariables": env}),
        "secretsmanager": SimpleNamespace(get_secret_value=lambda **kwargs: {"SecretString": "gateway-token"}),
        "bedrock-agentcore": SimpleNamespace(),
    }
    monkeypatch.setattr(module.boto3, "Session", lambda **kwargs: SimpleNamespace(
        client=lambda name, **kwargs: clients[name],
        resource=lambda name: SimpleNamespace(Table=lambda table: SimpleNamespace(get_item=get_item)),
    ))
    runtime = module.Runtime("us-east-1", "telegram:123")
    assert runtime.session_id == "existing-session" and runtime.user_id == "owner"
    assert reads[0]["Key"] == {"PK": "CHANNEL#telegram:123", "SK": "PROFILE"}
    assert reads[1]["Key"] == {"PK": "USER#owner", "SK": "SESSION"}
    assert all(read["ConsistentRead"] for read in reads)
    env["OPENCLAW_ENVIRONMENT"] = "prod"
    with pytest.raises(RuntimeError, match="does not enable dev"):
        module.Runtime("us-east-1", "telegram:123")


def test_invoke_uses_fixed_owner_origin_and_existing_session():
    module = load_script()
    runtime = module.Runtime.__new__(module.Runtime)
    runtime.arn, runtime.qualifier = "dev", "DEFAULT"
    runtime.user_id, runtime.session_id = "owner", "same-session"
    calls = []
    runtime.client = SimpleNamespace(invoke_agent_runtime=lambda **kwargs: (
        calls.append(kwargs) or {"response": io.BytesIO(b'{"pending":[]}')}))
    runtime.device_client = runtime.client
    assert runtime.invoke("control_ui_devices", command="list") == {"pending": []}
    assert calls[0]["runtimeSessionId"] == "same-session"
    assert json.loads(calls[0]["payload"]) == {
        "action": "control_ui_devices", "userId": "owner", "origin": module.ORIGIN, "command": "list",
    }


def test_readiness_probes_real_ui_and_rejects_old_session_without_creating_new_one():
    module = load_script()
    runtime = module.Runtime.__new__(module.Runtime)
    runtime.user_id, runtime.actor_id = "owner", "telegram:123"
    calls = []

    def invoke(action, **kwargs):
        calls.append((action, kwargs))
        return {"warmup": {"status": "ready"},
                "status": {"response": '{"currentUserId":"owner","openclawReady":true,"proxyReady":true}'},
                "control_ui_http": {"status": 200, "body": "bundled-html"}}[action]

    runtime.invoke = invoke
    runtime.ensure_ready()
    assert calls == [("status", {}), ("control_ui_http", {"path": "/"})]
    runtime.invoke = lambda action, **kwargs: (
        {"response": "Unknown action"} if action == "control_ui_http" else invoke(action, **kwargs))
    with pytest.raises(RuntimeError, match="predates Control UI"):
        runtime.ensure_ready()


def test_relay_serializes_existing_session_readiness_checks():
    module = load_script()
    calls = []
    relay = module.Relay(SimpleNamespace(token="test", ensure_ready=lambda: calls.append("same-session")))

    async def check():
        await asyncio.gather(relay.ensure_ready(), relay.ensure_ready())

    asyncio.run(check())
    assert calls == ["same-session"]


def test_readiness_recovers_transient_transport_failure_without_retrying_approval(monkeypatch):
    module = load_script()
    runtime = module.Runtime.__new__(module.Runtime)
    runtime.user_id, runtime.actor_id = "owner", "telegram:123"
    calls = []
    replies = iter([
        module.RuntimeUnavailable("provisioning timeout"),
        {"response": '{"currentUserId":null,"openclawReady":false}'},
        {"status": "initializing"},
        {"response": '{"currentUserId":"owner","openclawReady":true,"proxyReady":true}'},
        {"status": 200, "body": "html"},
    ])

    def invoke(action, **kwargs):
        calls.append(action)
        reply = next(replies)
        if isinstance(reply, Exception):
            raise reply
        return reply

    runtime.invoke = invoke
    monkeypatch.setattr(module.time, "sleep", lambda _: None)
    runtime.ensure_ready()
    assert calls == ["status", "status", "warmup", "status", "control_ui_http"]


def test_approval_transport_timeout_is_safe_and_never_retried():
    module = load_script()
    runtime = module.Runtime.__new__(module.Runtime)
    calls = []

    def invoke(**kwargs):
        calls.append(kwargs)
        raise module.ReadTimeoutError(endpoint_url="https://example.invalid")

    runtime.device_client = SimpleNamespace(invoke_agent_runtime=invoke)
    runtime.arn, runtime.qualifier = "dev", "DEFAULT"
    runtime.user_id, runtime.session_id = "owner", "same-session"
    with pytest.raises(module.RuntimeUnavailable, match="never retried automatically"):
        runtime.invoke("control_ui_devices", command="approve", requestId="explicit-request")
    assert len(calls) == 1


def test_relay_surfaces_runtime_failure_without_traceback_or_credentials():
    module = load_script()
    from aiohttp.test_utils import TestClient, TestServer

    async def check():
        runtime = SimpleNamespace(token="PRIVATE-GATEWAY-TOKEN")
        relay = module.Relay(runtime)
        relay.handle = AsyncMock(side_effect=module.RuntimeUnavailable("PRIVATE-AWS-DETAIL"))
        async with TestClient(TestServer(relay.application())) as client:
            response = await client.get("/")
            assert response.status == 503
            assert response.headers["Retry-After"] == "5"
            text = await response.text()
            assert "reload" in text and "no browser was approved" in text
            assert "PRIVATE" not in text and "Traceback" not in text

    asyncio.run(check())


def test_document_navigation_restores_native_fragment_auth_once_without_rewriting_ui():
    module = load_script()
    from urllib.parse import urlsplit, parse_qs
    import base64

    async def check():
        calls = []
        runtime = SimpleNamespace(token="gateway-token", invoke=lambda action, **kwargs: (
            calls.append((action, kwargs)) or
            {"status": 200, "headers": {}, "body": base64.b64encode(b"native-html").decode()}))
        relay = module.Relay(runtime)
        relay.ensure_ready = AsyncMock()
        request = SimpleNamespace(host="127.0.0.1:18795", method="GET", path="/",
                                  headers={"Sec-Fetch-Mode": "navigate"},
                                  cookies={module.COOKIE: relay.cookie_secret}, query={})
        redirect = await relay.handle(request)
        assert redirect.status == 302 and not calls
        url = urlsplit(redirect.headers["Location"])
        assert url.path.startswith("/relay-navigation/") and not url.fragment
        assert redirect.headers["Referrer-Policy"] == "no-referrer"
        nonce = url.path.rsplit("/", 1)[1]
        helper = SimpleNamespace(host=request.host, cookies=request.cookies, headers={},
                                 match_info={"nonce": nonce})
        auth_page = await relay.navigation(helper)
        assert "location.hash" in auth_page.text and "fragment.set('token'" in auth_page.text
        assert "script-src 'nonce-" in auth_page.headers["Content-Security-Policy"]
        request.query = {"relay-navigation": nonce}
        response = await relay.handle(request)
        assert response.body == b"native-html"
        assert calls == [("control_ui_http", {"path": "/"})]
        # Reloading the consumed URL receives a new fragment, not AUTH_TOKEN_MISSING.
        replay = await relay.handle(request)
        assert replay.status == 302 and replay.headers["Location"] != redirect.headers["Location"]
        assert len(calls) == 1
        # Asset/service-worker requests do not get a fragment or navigation redirect.
        request.headers = {}
        assert (await relay.handle(request)).body == b"native-html"

    asyncio.run(check())


def test_native_head_icons_queries_and_service_worker_fetches():
    module = load_script()

    async def check():
        calls = []
        relay = module.Relay(SimpleNamespace(token="gateway-token", invoke=lambda action, **kwargs: (
            calls.append(kwargs) or {"status": 404, "headers": {}, "body": ""})))
        relay.ensure_ready = AsyncMock()
        request = SimpleNamespace(host="127.0.0.1:18795", method="HEAD",
                                  path="/control-ui-config.json", headers={},
                                  cookies={module.COOKIE: relay.cookie_secret}, query={})
        assert (await relay.handle(request)).status == 404
        assert calls[-1]["method"] == "HEAD"
        assert "authorization" in calls[-1]
        request.method = "GET"
        request.path = "/__openclaw__/workspace-icon/agent:main:main"
        request.raw_path = "/__openclaw__/workspace-icon/agent%3Amain%3Amain?v=2&token=secret&url=evil"
        request.query = {"v": "2", "token": "secret", "url": "evil"}
        assert (await relay.handle(request)).status == 404
        assert calls[-1]["path"] == "/__openclaw__/workspace-icon/agent%3Amain%3Amain?v=2"
        request.path = "/chat/main"
        request.raw_path = "/chat/main?relay-navigation=old&session=main&token=secret"
        request.query = {"relay-navigation": "old", "session": "main", "token": "secret"}
        # The native service worker fetches non-navigations; it must receive HTML,
        # not a redirect loop, even with a reused or expired navigation nonce.
        request.headers = {"Sec-Fetch-Mode": "same-origin"}
        await relay.handle(request)
        assert calls[-1] == {"path": "/chat/main?session=main"}
        request.headers = {"Sec-Fetch-Mode": "navigate"}
        redirect = await relay.handle(request)
        nonce = redirect.headers["Location"].rsplit("/", 1)[1]
        assert relay.navigation_targets[nonce].startswith("/chat/main?session=main&relay-navigation=")
        request.path = "/api/not-allowed"
        request.raw_path = request.path
        with pytest.raises(web.HTTPNotFound):
            await relay.handle(request)
        request.method = "POST"
        with pytest.raises(web.HTTPMethodNotAllowed):
            await relay.handle(request)

    asyncio.run(check())


def test_navigation_nonce_is_cookie_protected_expiring_and_bound_to_spa_path():
    module = load_script()

    async def check():
        relay = module.Relay(SimpleNamespace(token="gateway-token"))
        url = relay.navigation_url("/chat/main")
        nonce = url.split("relay-navigation=")[1].split("#")[0]
        relay.navigation_targets[nonce] = url.split("#")[0]
        request = SimpleNamespace(host="127.0.0.1:18795", headers={}, cookies={},
                                  match_info={"nonce": nonce})
        with pytest.raises(web.HTTPForbidden):
            await relay.navigation(request)
        request.cookies = {module.COOKIE: relay.cookie_secret}
        relay.navigations[nonce] = (0, "/chat/main")
        with pytest.raises(web.HTTPGone):
            await relay.navigation(request)
        request.method = "HEAD"
        request.path = "/ws"
        request.headers = {"Upgrade": "websocket", "Origin": module.ORIGIN}
        with pytest.raises(web.HTTPMethodNotAllowed):
            await relay.handle(request)

    asyncio.run(check())


def test_runtime_config_auth_requires_relay_cookie_and_preserves_explicit_auth():
    module = load_script()

    async def check():
        calls = []
        relay = module.Relay(SimpleNamespace(token="gateway-token", invoke=lambda action, **kwargs: (
            calls.append(kwargs) or {"status": 200, "headers": {}, "body": "e30="})))
        request = SimpleNamespace(host="127.0.0.1:18795", method="GET",
                                  path="/control-ui-config.json", headers={}, cookies={})
        with pytest.raises(web.HTTPForbidden):
            await relay.handle(request)
        assert not calls
        request.cookies = {module.COOKIE: relay.cookie_secret}
        await relay.handle(request)
        assert calls[-1]["authorization"] == "Bearer gateway-token"
        request.headers = {"Authorization": "Bearer supplied-token"}
        await relay.handle(request)
        assert calls[-1]["authorization"] == "Bearer supplied-token"

    asyncio.run(check())


@pytest.mark.parametrize("failure", ["kickoff", "browser_upgrade"])
def test_websocket_closes_remote_if_local_setup_fails(monkeypatch, failure):
    module = load_script()
    runtime = SimpleNamespace(token="test", signed_websocket=lambda: ("wss://example.invalid/ws", {}))
    relay = module.Relay(runtime)
    relay.ensure_ready = AsyncMock()
    remote = SimpleNamespace(send_str=AsyncMock(), close=AsyncMock())
    local = SimpleNamespace(prepare=AsyncMock())
    operation = remote.send_str if failure == "kickoff" else local.prepare
    operation.side_effect = ConnectionResetError("Disconnected during setup")
    monkeypatch.setattr(module.web, "WebSocketResponse", lambda **kwargs: local)
    request = SimpleNamespace(app={"http": SimpleNamespace(ws_connect=AsyncMock(return_value=remote))})
    with pytest.raises(ConnectionResetError, match="Disconnected during setup"):
        asyncio.run(relay.websocket(request))
    remote.close.assert_awaited_once()
    assert not relay.sockets
