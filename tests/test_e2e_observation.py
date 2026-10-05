from types import SimpleNamespace
from unittest.mock import MagicMock, patch
import pytest

from tests.e2e.bot_test import TestSubagent as SubagentChecks
from tests.e2e.log_tailer import TailResult, _parse_line
from tests.e2e.session import get_completed_subagent_runs


def test_delivery_metadata_accumulates_without_logging_chunk_contents():
    result = TailResult()
    _parse_line(
        "Response metadata len=50 warmup=False content_blocks=False markdown_table=False json_array=False",
        result,
    )
    _parse_line("Telegram delivery accepted format=HTML len=16", result)
    _parse_line("Telegram delivery accepted format=plain len=10", result)
    with pytest.raises(RuntimeError, match="Response contents are not logged"):
        _ = result.response_text
    assert result.response_len == 26
    assert result.delivered_chunks == 2
    assert result.plain_text_fallback
    assert result.is_warmup is False
    assert result.content_blocks is False
    assert result.markdown_table is False
    assert result.json_array is False
    assert not result.telegram_sent
    _parse_line("Telegram response sent to chat_id=test", result)
    assert result.telegram_sent


def test_missing_metadata_cannot_pass_content_or_warmup_checks():
    result = TailResult()
    with pytest.raises(RuntimeError, match="Response contents are not logged"):
        _ = result.response_text
    with pytest.raises(RuntimeError, match="Warm-up metadata was not observed"):
        _ = result.is_warmup


def test_metadata_reports_invalid_shapes_without_recording_response():
    result = TailResult()
    _parse_line(
        "Response metadata len=200 warmup=True content_blocks=True markdown_table=True json_array=True",
        result,
    )
    assert result.is_warmup
    assert result.content_blocks and result.markdown_table and result.json_array
    assert result.response_len == 200


def test_incomplete_delivery_does_not_pass_lifecycle():
    result = TailResult(message_received=True, agentcore_invoked=True)
    _parse_line("Telegram response delivery incomplete for chat_id=test", result)
    assert not result.full_lifecycle


def test_subagent_observation_uses_completed_runs_not_proxy_counter():
    with patch("tests.e2e.bot_test.get_completed_subagent_runs", return_value={"first", "second"}):
        assert SubagentChecks._get_subagent_count(object()) == 2


def test_child_run_trace_uses_latest_user_stream_and_deduplicates():
    cfg = SimpleNamespace(region="us-east-1", agentcore_stack_name="OpenClawAgentCore-dev")
    cf = MagicMock()
    cf.describe_stacks.return_value = {"Stacks": [{"Outputs": [
        {"OutputKey": "RuntimeArn", "OutputValue": "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/dev-runtime"},
    ]}]}
    logs = MagicMock()
    paginator = logs.get_paginator.return_value
    paginator.paginate.side_effect = [
        [{"events": [
            {"timestamp": 1, "logStreamName": "old-user-stream"},
            {"timestamp": 2, "logStreamName": "current-user-stream"},
        ]}],
        [{"events": [
            {"message": "Ignoring chat final for runId=done sessionKey=agent:main:subagent:child (subagent)"},
            {"message": "Ignoring chat final for runId=done sessionKey=agent:main:subagent:child (subagent)"},
            {"message": "Ignoring chat final for runId=main sessionKey=agent:main:main (other-run)"},
            {"message": "Ignoring chat error for runId=failed sessionKey=agent:main:subagent:child (subagent)"},
        ]}],
    ]
    with patch("tests.e2e.session.get_user_id", return_value="user_test"):
        with patch("tests.e2e.session.boto3.client", side_effect=[cf, logs]):
            assert get_completed_subagent_runs(cfg) == {"done"}
    calls = paginator.paginate.call_args_list
    assert calls[0].kwargs["filterPattern"] == '"Init for user=user_test"'
    assert calls[1].kwargs["logStreamNames"] == ["current-user-stream"]
