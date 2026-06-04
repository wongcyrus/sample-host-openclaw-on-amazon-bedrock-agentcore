#!/usr/bin/env python3
"""OpenClaw on AgentCore Runtime — CDK Application entry point.

Architecture: Per-user AgentCore Runtime sessions with webhook-based
channel ingestion via Router Lambda. No keepalive needed — sessions
idle-terminate naturally.

Deployment model:
  Phase 1 (CDK): VPC, Security, Guardrails, Observability
  Phase 2 (CDK): AgentCore runtime stack (Role/SG/S3/Runtime/Endpoint/Browser)
  Phase 3 (CDK): Router, Cron, TokenMonitoring
"""

import os

import boto3
from botocore.exceptions import ClientError, EndpointConnectionError, NoCredentialsError

import aws_cdk as cdk
import cdk_nag

from stacks import DeploymentNamer
from stacks.vpc_stack import VpcStack
from stacks.security_stack import SecurityStack
from stacks.agentcore_stack import AgentCoreStack
from stacks.router_stack import RouterStack
from stacks.guardrails_stack import GuardrailsStack
from stacks.cron_stack import CronStack
from stacks.observability_stack import ObservabilityStack
from stacks.token_monitoring_stack import TokenMonitoringStack

app = cdk.App()
namer = DeploymentNamer.from_scope(app)

env = cdk.Environment(
    account=app.node.try_get_context("account") or os.environ.get("CDK_DEFAULT_ACCOUNT"),
    region=app.node.try_get_context("region") or os.environ.get("CDK_DEFAULT_REGION"),
)


def resolve_existing_security_cmk_arn() -> str | None:
    """Return the deployed security CMK ARN when the alias already exists.

    This avoids CDK cross-stack exports for steady-state updates while still
    allowing first-time deployments to wire stacks together normally.
    """
    region = env.region or os.environ.get("CDK_DEFAULT_REGION")
    if not region:
        return None

    alias_name = f"alias/{namer.name('openclaw/secrets')}"
    try:
        kms_client = boto3.client("kms", region_name=region)
        return kms_client.describe_key(KeyId=alias_name)["KeyMetadata"]["Arn"]
    except ClientError as err:
        error_code = str(err.response.get("Error", {}).get("Code", ""))
        if error_code in {"NotFoundException", "InvalidArnException"}:
            return None
        raise
    except (NoCredentialsError, EndpointConnectionError):
        return None


def resolve_existing_secret(secret_name: str) -> dict[str, str] | None:
    """Return existing secret name/arn if it already exists."""
    region = env.region or os.environ.get("CDK_DEFAULT_REGION")
    if not region:
        return None

    try:
        secrets_client = boto3.client("secretsmanager", region_name=region)
        description = secrets_client.describe_secret(SecretId=secret_name)
        return {
            "name": secret_name,
            "arn": description["ARN"],
        }
    except ClientError as err:
        error_code = str(err.response.get("Error", {}).get("Code", ""))
        if error_code == "ResourceNotFoundException":
            return None
        raise
    except (NoCredentialsError, EndpointConnectionError):
        return None


def resolve_existing_user_pool(pool_name: str) -> str | None:
    """Return an existing Cognito user pool ID by deterministic name."""
    region = env.region or os.environ.get("CDK_DEFAULT_REGION")
    if not region:
        return None

    try:
        cognito_client = boto3.client("cognito-idp", region_name=region)
        paginator = cognito_client.get_paginator("list_user_pools")
        for page in paginator.paginate(MaxResults=60):
            for user_pool in page.get("UserPools", []):
                if user_pool.get("Name") == pool_name:
                    return user_pool["Id"]
        return None
    except (ClientError, NoCredentialsError, EndpointConnectionError):
        return None


def resolve_existing_user_pool_client(pool_id: str, client_name: str) -> str | None:
    """Return an existing Cognito user pool client ID by deterministic name."""
    region = env.region or os.environ.get("CDK_DEFAULT_REGION")
    if not region or not pool_id:
        return None

    try:
        cognito_client = boto3.client("cognito-idp", region_name=region)
        paginator = cognito_client.get_paginator("list_user_pool_clients")
        for page in paginator.paginate(UserPoolId=pool_id, MaxResults=60):
            for client in page.get("UserPoolClients", []):
                if client.get("ClientName") == client_name:
                    return client["ClientId"]
        return None
    except (ClientError, NoCredentialsError, EndpointConnectionError):
        return None


def require_resolved(name: str, value):
    """Require a resolved value when migrating an existing deployment."""
    if value is None or value == "":
        raise ValueError(
            f"Expected existing deployment resource for {name}, but it could not be resolved."
        )
    return value

# --- Foundation ---
vpc_stack = VpcStack(app, namer.stack("OpenClawVpc"), env=env)

security_stack = SecurityStack(app, namer.stack("OpenClawSecurity"), env=env)
existing_security_cmk_arn = resolve_existing_security_cmk_arn()
existing_security_deployment = existing_security_cmk_arn is not None

if existing_security_deployment:
    security_cmk_arn = existing_security_cmk_arn
    gateway_token_secret = require_resolved(
        "gateway token secret",
        resolve_existing_secret(namer.name("openclaw/gateway-token")),
    )
    webhook_secret = require_resolved(
        "webhook secret",
        resolve_existing_secret(namer.name("openclaw/webhook-secret")),
    )
    cognito_password_secret = require_resolved(
        "cognito password secret",
        resolve_existing_secret(namer.name("openclaw/cognito-password-secret")),
    )
    telegram_secret = require_resolved(
        "telegram secret",
        resolve_existing_secret(namer.name("openclaw/channels/telegram")),
    )
    slack_secret = require_resolved(
        "slack secret",
        resolve_existing_secret(namer.name("openclaw/channels/slack")),
    )
    feishu_secret = require_resolved(
        "feishu secret",
        resolve_existing_secret(namer.name("openclaw/channels/feishu")),
    )
    user_pool_id = require_resolved(
        "cognito user pool",
        resolve_existing_user_pool(namer.name("openclaw-identity-pool")),
    )
    user_pool_client_id = require_resolved(
        "cognito user pool client",
        resolve_existing_user_pool_client(
            user_pool_id,
            namer.name("openclaw-proxy"),
        ),
    )
    cognito_issuer_url = (
        f"https://cognito-idp.{env.region or os.environ.get('CDK_DEFAULT_REGION')}.amazonaws.com/{user_pool_id}"
    )
else:
    security_cmk_arn = security_stack.cmk.key_arn
    gateway_token_secret = {
        "name": security_stack.gateway_token_secret.secret_name,
        "arn": security_stack.gateway_token_secret.secret_arn,
    }
    webhook_secret = {
        "name": security_stack.webhook_secret.secret_name,
        "arn": security_stack.webhook_secret.secret_arn,
    }
    cognito_password_secret = {
        "name": security_stack.cognito_password_secret.secret_name,
        "arn": security_stack.cognito_password_secret.secret_arn,
    }
    telegram_secret = {
        "name": security_stack.channel_secrets["telegram"].secret_name,
        "arn": security_stack.channel_secrets["telegram"].secret_arn,
    }
    slack_secret = {
        "name": security_stack.channel_secrets["slack"].secret_name,
        "arn": security_stack.channel_secrets["slack"].secret_arn,
    }
    feishu_secret = {
        "name": security_stack.channel_secrets["feishu"].secret_name,
        "arn": security_stack.channel_secrets["feishu"].secret_arn,
    }
    user_pool_id = security_stack.user_pool_id
    user_pool_client_id = security_stack.user_pool_client_id
    cognito_issuer_url = security_stack.cognito_issuer_url

# --- Guardrails (Bedrock content filtering — opt-in via enable_guardrails) ---
guardrails_stack = GuardrailsStack(
    app,
    namer.stack("OpenClawGuardrails"),
    cmk_arn=security_cmk_arn,
    env=env,
)

# --- AgentCore runtime resources (Role, SG, S3, Runtime, Endpoint) ---
agentcore_stack = AgentCoreStack(
    app,
    namer.stack("OpenClawAgentCore"),
    cmk_arn=security_cmk_arn,
    vpc=vpc_stack.vpc,
    private_subnets=vpc_stack.vpc.private_subnets,
    private_subnet_ids=[s.subnet_id for s in vpc_stack.vpc.private_subnets],
    cognito_issuer_url=cognito_issuer_url,
    cognito_client_id=user_pool_client_id,
    cognito_user_pool_id=user_pool_id,
    cognito_password_secret_name=cognito_password_secret["name"],
    cognito_password_secret_arn=cognito_password_secret["arn"],
    gateway_token_secret_name=gateway_token_secret["name"],
    gateway_token_secret_arn=gateway_token_secret["arn"],
    telegram_token_secret_name=telegram_secret["name"],
    telegram_token_secret_arn=telegram_secret["arn"],
    guardrail_id=guardrails_stack.guardrail_id or "",
    guardrail_version=guardrails_stack.guardrail_version or "",
    env=env,
)

# --- Router (Lambda + API Gateway HTTP API for Telegram/Slack webhooks) ---
router_stack = RouterStack(
    app,
    namer.stack("OpenClawRouter"),
    gateway_token_secret_name=gateway_token_secret["name"],
    gateway_token_secret_arn=gateway_token_secret["arn"],
    telegram_token_secret_name=telegram_secret["name"],
    telegram_token_secret_arn=telegram_secret["arn"],
    slack_token_secret_name=slack_secret["name"],
    slack_token_secret_arn=slack_secret["arn"],
    feishu_token_secret_name=feishu_secret["name"],
    feishu_token_secret_arn=feishu_secret["arn"],
    webhook_secret_name=webhook_secret["name"],
    webhook_secret_arn=webhook_secret["arn"],
    cmk_arn=security_cmk_arn,
    user_files_bucket_name=agentcore_stack.user_files_bucket.bucket_name,
    user_files_bucket_arn=agentcore_stack.user_files_bucket.bucket_arn,
    env=env,
)

# --- Cron (EventBridge Scheduler + Lambda executor) ---
# Use deterministic string ARNs for identity table to avoid cyclic dependency
# (AgentCore <- Router already exists; CronStack adds policies to AgentCore role)
_region = env.region or os.environ.get("CDK_DEFAULT_REGION", "")
_account = env.account or os.environ.get("CDK_DEFAULT_ACCOUNT", "")
_identity_table_name = namer.name("openclaw-identity")
_identity_table_arn = f"arn:aws:dynamodb:{_region}:{_account}:table/{_identity_table_name}"

cron_stack = CronStack(
    app,
    namer.stack("OpenClawCron"),
    identity_table_name=_identity_table_name,
    identity_table_arn=_identity_table_arn,
    telegram_token_secret_name=telegram_secret["name"],
    telegram_token_secret_arn=telegram_secret["arn"],
    slack_token_secret_name=slack_secret["name"],
    slack_token_secret_arn=slack_secret["arn"],
    feishu_token_secret_name=feishu_secret["name"],
    feishu_token_secret_arn=feishu_secret["arn"],
    cmk_arn=security_cmk_arn,
    agentcore_execution_role=agentcore_stack.execution_role,
    env=env,
)

# --- Observability (dashboards + alarms) ---
observability_stack = ObservabilityStack(
    app,
    namer.stack("OpenClawObservability"),
    cmk_arn=security_cmk_arn,
    env=env,
)

# --- Token Monitoring ---
token_monitoring_stack = TokenMonitoringStack(
    app,
    namer.stack("OpenClawTokenMonitoring"),
    invocation_log_group=observability_stack.invocation_log_group,
    alarm_topic=observability_stack.alarm_topic,
    cmk_arn=security_cmk_arn,
    env=env,
)

# --- cdk-nag security checks ---
cdk.Aspects.of(app).add(cdk_nag.AwsSolutionsChecks(verbose=True))

app.synth()
