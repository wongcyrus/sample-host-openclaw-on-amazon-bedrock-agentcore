import pytest
from aws_cdk import App, Environment, Stack, aws_iam as iam
from aws_cdk.assertions import Template

from stacks.cron_stack import CronStack


@pytest.mark.parametrize("retained_key", [True, False])
def test_runtime_and_cron_use_actual_identity_table_key(monkeypatch, retained_key):
    monkeypatch.setenv("OPENCLAW_ENV_SUFFIX", "test")
    env = Environment(account="123456789012", region="us-east-1")
    app = App()
    runtime = Stack(app, "Runtime", env=env)
    role = iam.Role(
        runtime, "ExecutionRole", assumed_by=iam.ServicePrincipal("bedrock-agentcore.amazonaws.com")
    )
    current_key = "arn:aws:kms:us-east-1:123456789012:key/current"
    table_key = "arn:aws:kms:us-east-1:123456789012:key/retained" if retained_key else current_key
    cron = CronStack(
        app, "Cron", env=env,
        identity_table_name="openclaw-identity-test",
        identity_table_arn="arn:aws:dynamodb:us-east-1:123456789012:table/openclaw-identity-test",
        identity_table_kms_arn=table_key,
        cmk_arn=current_key,
        agentcore_execution_role=role,
        **{
            f"{channel}_token_secret_{field}": (
                f"openclaw/channels/{channel}-test" if field == "name"
                else f"arn:aws:secretsmanager:us-east-1:123456789012:secret:{channel}-test"
            )
            for channel in ("telegram", "slack", "feishu")
            for field in ("name", "arn")
        },
    )
    expected = {
        "Action": ["kms:Decrypt", "kms:GenerateDataKey"],
        "Effect": "Allow",
        "Resource": table_key,
        "Condition": {"StringEquals": {"kms:ViaService": "dynamodb.us-east-1.amazonaws.com"}},
    }
    for stack in (runtime, cron):
        policies = Template.from_stack(stack).find_resources("AWS::IAM::Policy")
        statements = [
            statement
            for policy in policies.values()
            for statement in policy["Properties"]["PolicyDocument"]["Statement"]
        ]
        assert expected in statements
        assert not any(
            statement.get("Resource") == "*"
            and "kms:Decrypt" in statement.get("Action", [])
            for statement in statements
        )
