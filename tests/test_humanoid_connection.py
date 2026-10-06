import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest


def load_skill():
    path = Path(__file__).resolve().parents[1] / "bridge/skills/humanoid/scripts/skill.py"
    spec = importlib.util.spec_from_file_location("humanoid_connection_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_connection_check_uses_authoritative_env_and_never_calls_actions(monkeypatch, capsys):
    skill = load_skill()
    monkeypatch.setenv("HUMANOID_MCP_SERVER_URL", "https://new.invalid/mcp")
    monkeypatch.setenv("MCP_SERVER_URL", "https://old.invalid/mcp")
    monkeypatch.setattr(sys, "argv", ["skill.py", "--check-connection"])
    monkeypatch.setattr(skill, "create_auth", lambda *args: None)

    def post(url, **kwargs):
        assert url == "https://new.invalid/mcp"
        assert kwargs["json"]["method"] == "tools/list"
        return SimpleNamespace(
            status_code=200, raise_for_status=lambda: None,
            json=lambda: {"result": {"tools": [{"name": "robot_wave"}]}},
        )

    monkeypatch.setitem(sys.modules, "requests", SimpleNamespace(
        post=post, RequestException=RuntimeError,
    ))
    with pytest.raises(SystemExit) as result:
        skill.main()
    assert result.value.code == 0
    assert json.loads(capsys.readouterr().out)["toolNames"] == ["robot_wave"]


def test_connection_check_fails_on_mcp_error(monkeypatch):
    skill = load_skill()
    monkeypatch.setitem(sys.modules, "requests", SimpleNamespace(
        post=lambda *args, **kwargs: SimpleNamespace(
            status_code=200, raise_for_status=lambda: None,
            json=lambda: {"error": {"code": -32603}},
        ),
        RequestException=RuntimeError,
    ))
    assert skill.check_connection("https://example.invalid/mcp", None, {}) is False
