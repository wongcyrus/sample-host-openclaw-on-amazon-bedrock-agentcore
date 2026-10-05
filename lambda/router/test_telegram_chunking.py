"""Regression tests for Telegram UTF-16 message limits in the Router."""

import os
import sys
import unittest
import io
import json
from contextlib import ExitStack
from unittest.mock import MagicMock, patch

os.environ.setdefault("AGENTCORE_RUNTIME_ARN_PARAMETER", "/test/runtime-arn")
os.environ.setdefault("AGENTCORE_QUALIFIER_PARAMETER", "/test/runtime-endpoint")
os.environ.setdefault("IDENTITY_TABLE_NAME", "openclaw-identity")
os.environ.setdefault("USER_FILES_BUCKET", "openclaw-user-files-123456789012-us-west-2")

sys.modules["boto3"] = MagicMock()
sys.modules["botocore"] = MagicMock()
sys.modules["botocore.config"] = MagicMock()
sys.modules["botocore.exceptions"] = MagicMock()

import importlib
index = importlib.import_module("index")


class TestTelegramChunking(unittest.TestCase):
    def test_runtime_response_contents_are_not_logged(self):
        secret_reply = "synthetic-private-credential-for-log-regression"
        body = io.BytesIO(json.dumps({"response": secret_reply}).encode())
        with patch.object(index, "_get_runtime_config", return_value=("test-runtime", "DEFAULT")):
            with patch.object(index.agentcore_client, "invoke_agent_runtime", return_value={
                "statusCode": 200, "response": body,
            }):
                with self.assertLogs(index.logger, level="INFO") as captured:
                    result = index.invoke_agent_runtime("test-session", "test-user", "test:123", "test", "hello")
        self.assertEqual(result["response"], secret_reply)
        self.assertNotIn(secret_reply, "\n".join(captured.output))

    def test_reply_contents_are_not_logged(self):
        secret_reply = "synthetic-private-credential-for-log-regression"
        with ExitStack() as stack:
            for name, value in {
                "_get_telegram_token": "synthetic-token",
                "resolve_user": ("user_test", False),
                "get_or_create_session": "session_test",
                "invoke_agent_runtime": {"response": secret_reply},
                "_send_telegram_chunks": True,
            }.items():
                stack.enter_context(patch.object(index, name, return_value=value))
            stack.enter_context(patch.object(index, "send_telegram_typing"))
            stack.enter_context(patch.object(index, "_periodic_typing"))
            with self.assertLogs(index.logger, level="INFO") as captured:
                index.handle_telegram({"message": {
                    "chat": {"id": "test_chat"},
                    "from": {"id": "123"},
                    "text": "Get my test key",
                }})
        logs = "\n".join(captured.output)
        self.assertNotIn(secret_reply, logs)
        self.assertIn("Response metadata len=", logs)

    def test_utf16_length_counts_astral_characters_twice(self):
        self.assertEqual(index._utf16_len("a😀"), 3)

    def test_chunks_rejoin_and_respect_utf16_limit(self):
        text = "😀" * 2100 + "終"
        chunks = index._split_telegram_text(text)

        self.assertGreater(len(chunks), 1)
        self.assertEqual("".join(chunks), text)
        self.assertTrue(all(index._utf16_len(chunk) <= 4000 for chunk in chunks))

    def test_prefers_paragraph_boundaries(self):
        text = "a" * 2100 + "\n\n" + "b" * 2100
        chunks = index._split_telegram_text(text)

        self.assertEqual(chunks[0], "a" * 2100 + "\n\n")
        self.assertEqual("".join(chunks), text)

    def test_send_retries_rejected_chunk_as_smaller_pieces(self):
        with patch.object(
            index,
            "send_telegram_message",
            side_effect=[False, True, True, True],
        ) as send:
            delivered = index._send_telegram_chunks(
                "chat", "x" * 90, "token", limit=80
            )

        self.assertTrue(delivered)
        self.assertEqual(send.call_count, 4)

    def test_reports_failed_chunks(self):
        with patch.object(index, "send_telegram_message", return_value=False):
            self.assertFalse(
                index._send_telegram_chunks("chat", "x" * 90, "token", limit=80)
            )


if __name__ == "__main__":
    unittest.main()
