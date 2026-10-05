"""Regression tests for Cron Lambda Telegram UTF-16 message limits."""

import os
import sys
import unittest
import io
import json
import importlib.util
from pathlib import Path
from unittest.mock import MagicMock, patch

os.environ.setdefault("AGENTCORE_RUNTIME_ARN_PARAMETER", "/test/runtime-arn")
os.environ.setdefault("AGENTCORE_QUALIFIER_PARAMETER", "/test/runtime-endpoint")
os.environ.setdefault("IDENTITY_TABLE_NAME", "openclaw-identity")

sys.modules["boto3"] = MagicMock()
sys.modules["botocore"] = MagicMock()
sys.modules["botocore.config"] = MagicMock()
sys.modules["botocore.exceptions"] = MagicMock()

spec = importlib.util.spec_from_file_location(
    "cron_lambda_index", Path(__file__).with_name("index.py")
)
index = importlib.util.module_from_spec(spec)
spec.loader.exec_module(index)


class TestTelegramChunking(unittest.TestCase):
    def test_runtime_response_contents_are_not_logged(self):
        secret_reply = "synthetic-private-credential-for-log-regression"
        body = io.BytesIO(json.dumps({"response": secret_reply}).encode())
        with patch.object(index, "_get_runtime_config", return_value=("test-runtime", "DEFAULT")):
            with patch.object(index.agentcore_client, "invoke_agent_runtime", return_value={
                "response": body,
            }):
                with self.assertLogs(index.logger, level="INFO") as captured:
                    result = index.invoke_agentcore("test-session", "cron", "test-user", "test:123", "test", "hello")
        self.assertEqual(result["response"], secret_reply)
        self.assertNotIn(secret_reply, "\n".join(captured.output))

    def test_table_preserves_already_bold_names(self):
        for name in ("**Status**", "__Status__"):
            self.assertEqual(
                index._markdown_to_telegram_html(
                    f"| Name | Value |\n|---|---|\n| {name} | Ready |"
                ),
                "\u2022 <b>Status</b> \u2014 Ready",
            )

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

    def test_cron_delivery_reports_missing_token(self):
        with patch.object(index, "_get_telegram_token", return_value=""):
            with patch.object(index, "_send_telegram_chunks") as send_chunks:
                index.deliver_response("telegram", "chat", "scheduled reply")

        send_chunks.assert_not_called()


if __name__ == "__main__":
    unittest.main()
