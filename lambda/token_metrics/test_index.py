import importlib.util
import os
from pathlib import Path


os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test")
os.environ.setdefault("AWS_REGION", "us-west-2")
os.environ.setdefault("TABLE_NAME", "test-token-usage")


def load_module():
    module_path = Path(__file__).with_name("index.py")
    spec = importlib.util.spec_from_file_location("token_metrics_index", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_extract_openclaw_metadata_includes_environment():
    module = load_module()

    metadata = module.extract_openclaw_metadata(
        {
            "requestMetadata": {
                "openclaw.actor_id": "telegram:123",
                "openclaw.session_id": "ses-123",
                "openclaw.channel": "telegram",
                "openclaw.environment": "dev",
            }
        }
    )

    assert metadata == {
        "actor_id": "telegram:123",
        "session_id": "ses-123",
        "channel": "telegram",
        "environment": "dev",
    }


def test_write_to_dynamodb_namespaces_records_by_environment():
    module = load_module()
    captured = {}

    class FakeTable:
        def update_item(self, **kwargs):
            captured.update(kwargs)

    module.table = FakeTable()
    module.write_to_dynamodb(
        {
            "actor_id": "telegram:123",
            "session_id": "ses-123",
            "channel": "telegram",
            "environment": "dev",
            "model_id": "moonshotai.kimi-k2.5",
            "input_tokens": 10,
            "output_tokens": 5,
            "total_tokens": 15,
            "estimated_cost_usd": 0.01,
            "timestamp": "2026-06-09T00:00:00+00:00",
            "date": "2026-06-09",
        }
    )

    assert captured["Key"] == {
        "PK": "USER#telegram:123",
        "SK": "ENV#dev#DATE#2026-06-09#CHANNEL#telegram#SESSION#ses-123",
    }
    values = captured["ExpressionAttributeValues"]
    assert values[":g1pk"] == "ENV#dev#CHANNEL#telegram"
    assert values[":g2pk"] == "ENV#dev#MODEL#moonshotai.kimi-k2.5"
    assert values[":g3pk"] == "ENV#dev#DATE#2026-06-09"
    assert values[":environment"] == "dev"


def test_publish_metrics_emits_environment_dimension_and_aggregate_series():
    module = load_module()
    calls = []

    class FakeCloudWatch:
        def put_metric_data(self, **kwargs):
            calls.append(kwargs)

    module.cloudwatch = FakeCloudWatch()
    module.publish_metrics(
        {
            "actor_id": "telegram:123",
            "session_id": "ses-123",
            "channel": "telegram",
            "environment": "prod",
            "model_id": "moonshotai.kimi-k2.5",
            "input_tokens": 10,
            "output_tokens": 5,
            "total_tokens": 15,
            "estimated_cost_usd": 0.01,
            "timestamp": "2026-06-09T00:00:00+00:00",
            "date": "2026-06-09",
        }
    )

    metric_data = [item for call in calls for item in call["MetricData"]]
    dimensions = [tuple((d["Name"], d["Value"]) for d in item["Dimensions"]) for item in metric_data]

    assert (("Environment", "prod"),) in dimensions
    assert (
        ("Environment", "prod"),
        ("ActorId", "telegram:123"),
        ("Channel", "telegram"),
        ("ModelId", "moonshotai.kimi-k2.5"),
    ) in dimensions
    assert tuple() in dimensions


def test_process_log_entry_reads_nested_bedrock_token_counts():
    module = load_module()
    captured = {}

    def fake_write(record):
        captured["record"] = record

    def fake_publish(record):
        captured["published"] = record

    module.write_to_dynamodb = fake_write
    module.publish_metrics = fake_publish

    module.process_log_entry(
        {
            "timestamp": "2026-06-09T00:00:00Z",
            "modelId": "moonshotai.kimi-k2.5",
            "requestMetadata": {
                "openclaw.actor_id": "telegram:123",
                "openclaw.channel": "telegram",
                "openclaw.session_id": "ses-123",
                "openclaw.environment": "dev",
            },
            "input": {"inputTokenCount": 1915},
            "output": {"outputTokenCount": 81},
        }
    )

    assert captured["record"]["input_tokens"] == 1915
    assert captured["record"]["output_tokens"] == 81
    assert captured["record"]["total_tokens"] == 1996
    assert captured["record"]["environment"] == "dev"
    assert captured["published"]["total_tokens"] == 1996
