import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace

import pytest


def load_script():
    path = Path(__file__).resolve().parents[1] / "scripts/debug-openclaw.py"
    spec = importlib.util.spec_from_file_location("debug_openclaw_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def setup_clients(monkeypatch, module, reply):
    class Table:
        def get_item(self, **kwargs):
            assert kwargs["ConsistentRead"] is True
            if kwargs["Key"]["PK"].startswith("CHANNEL#"):
                return {"Item": {"userId": "user_test"}}
            return {"Item": {"sessionId": "existing_session"}}

    def invoke(**kwargs):
        assert kwargs["runtimeSessionId"] == "existing_session"
        payload = json.loads(kwargs["payload"])
        assert payload == {
            "action": "diagnostics", "userId": "user_test", "limit": 500, "checkMcp": True,
        }
        return {"response": io.BytesIO(json.dumps(reply).encode())}

    cf = SimpleNamespace(describe_stacks=lambda **kwargs: {"Stacks": [{"Outputs": [
        {"OutputKey": "RuntimeArn", "OutputValue": "dev-runtime"},
        {"OutputKey": "RuntimeEndpointId", "OutputValue": "DEFAULT"},
    ]}]})
    monkeypatch.setattr(module.boto3, "client", lambda name, **kwargs:
                        cf if name == "cloudformation" else SimpleNamespace(invoke_agent_runtime=invoke))
    monkeypatch.setattr(module.boto3, "resource", lambda *args, **kwargs:
                        SimpleNamespace(Table=lambda name: Table()))


def test_debug_uses_existing_session_without_chat(monkeypatch):
    module = load_script()
    setup_clients(monkeypatch, module, {"status": "ready", "nativeLogs": "raw file logs"})
    result = module.collect(region="us-east-1", suffix="dev", actor_id="telegram:123",
                            limit=500, check_mcp=True)
    assert result["nativeLogs"] == "raw file logs"


def test_debug_fails_explicitly_on_old_runtime(monkeypatch):
    module = load_script()
    setup_clients(monkeypatch, module, {"response": "Unknown action", "status": "running"})
    with pytest.raises(RuntimeError, match="does not support"):
        module.collect(region="us-east-1", suffix="dev", actor_id="telegram:123",
                       limit=500, check_mcp=True)
