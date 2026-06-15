from aws_cdk import (
    Stack,
    CfnOutput,
    Duration,
    aws_apigatewayv2 as apigwv2,
    aws_apigatewayv2_integrations as apigwv2_integrations,
    aws_iam as iam,
    aws_lambda as _lambda,
    aws_kms as kms,
)
from constructs import Construct
from stacks import DeploymentNamer

class AdminDashboardStack(Stack):
    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        identity_table_name: str,
        user_files_bucket_name: str,
        cmk_arn: str,
        runtime_arn_parameter_name: str,
        runtime_endpoint_parameter_name: str,
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)
        
        namer = DeploymentNamer.from_scope(self)

        admin_password_secret = kms.Key.from_key_arn(self, "CMK", cmk_arn)
        
        from aws_cdk import aws_secretsmanager as secretsmanager
        admin_secret = secretsmanager.Secret(
            self,
            "AdminPassword",
            secret_name=namer.name("openclaw/admin-dashboard-password"),
            generate_secret_string=secretsmanager.SecretStringGenerator(
                password_length=16,
                exclude_punctuation=True
            ),
            encryption_key=admin_password_secret
        )

        admin_lambda = _lambda.Function(
            self,
            "AdminApiHandler",
            function_name=namer.name("AdminApi"),
            runtime=_lambda.Runtime.PYTHON_3_12,
            code=_lambda.Code.from_asset("admin_api"),
            handler="index.handler",
            timeout=Duration.seconds(60), # longer timeout for global reset
            memory_size=512,
            environment={
                "IDENTITY_TABLE_NAME": identity_table_name,
                "USER_FILES_BUCKET_NAME": user_files_bucket_name,
                "AGENTCORE_RUNTIME_ARN_PARAMETER": runtime_arn_parameter_name,
                "AGENTCORE_QUALIFIER_PARAMETER": runtime_endpoint_parameter_name,
                "ADMIN_SECRET_ARN": admin_secret.secret_arn,
            }
        )

        admin_secret.grant_read(admin_lambda)

        # Least privilege: AgentCore
        admin_lambda.add_to_role_policy(
            iam.PolicyStatement(
                actions=[
                    "bedrock-agentcore:StopRuntimeSession",
                    "bedrock-agentcore:ListSessions",
                ],
                resources=[
                    f"arn:aws:bedrock-agentcore:{self.region}:{self.account}:runtime/*"
                ]
            )
        )
        
        # Least privilege: SSM Parameters
        admin_lambda.add_to_role_policy(
            iam.PolicyStatement(
                actions=["ssm:GetParameter"],
                resources=[
                    f"arn:aws:ssm:{self.region}:{self.account}:parameter{runtime_arn_parameter_name}",
                    f"arn:aws:ssm:{self.region}:{self.account}:parameter{runtime_endpoint_parameter_name}"
                ]
            )
        )

        # Least privilege: DynamoDB
        admin_lambda.add_to_role_policy(
            iam.PolicyStatement(
                actions=["dynamodb:Scan", "dynamodb:GetItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"],
                resources=[f"arn:aws:dynamodb:{self.region}:{self.account}:table/{identity_table_name}"]
            )
        )

        # Least privilege: S3
        admin_lambda.add_to_role_policy(
            iam.PolicyStatement(
                actions=["s3:ListBucket", "s3:DeleteObject"],
                resources=[
                    f"arn:aws:s3:::{user_files_bucket_name}",
                    f"arn:aws:s3:::{user_files_bucket_name}/*"
                ]
            )
        )

        # Least privilege: KMS
        admin_lambda.add_to_role_policy(
            iam.PolicyStatement(
                actions=["kms:Decrypt", "kms:GenerateDataKey"],
                resources=[cmk_arn]
            )
        )

        http_api = apigwv2.HttpApi(
            self,
            "AdminHttpApi",
            api_name=namer.name("AdminAPI"),
            create_default_stage=True,
            cors_preflight=apigwv2.CorsPreflightOptions(
                allow_origins=["*"],
                allow_methods=[apigwv2.CorsHttpMethod.ANY],
            )
        )

        integration = apigwv2_integrations.HttpLambdaIntegration(
            "AdminIntegration", handler=admin_lambda
        )

        http_api.add_routes(
            path="/{proxy+}",
            methods=[apigwv2.HttpMethod.ANY],
            integration=integration,
        )
        http_api.add_routes(
            path="/",
            methods=[apigwv2.HttpMethod.GET],
            integration=integration,
        )

        CfnOutput(self, "AdminDashboardUrl", value=http_api.api_endpoint)

        import cdk_nag
        cdk_nag.NagSuppressions.add_stack_suppressions(
            self,
            [
                cdk_nag.NagPackSuppression(
                    id="AwsSolutions-L1",
                    reason="Python 3.12 is the intended runtime."
                ),
                cdk_nag.NagPackSuppression(
                    id="AwsSolutions-IAM4",
                    reason="Allow managed policies for basic execution."
                ),
                cdk_nag.NagPackSuppression(
                    id="AwsSolutions-IAM5",
                    reason="Wildcard permissions required for Bedrock list/end sessions and S3 user files wipe."
                ),
                cdk_nag.NagPackSuppression(
                    id="AwsSolutions-APIG1",
                    reason="Access logging not required for internal admin dashboard."
                ),
                cdk_nag.NagPackSuppression(
                    id="AwsSolutions-APIG4",
                    reason="Authorization handled externally/not required for this phase."
                ),
                cdk_nag.NagPackSuppression(
                    id="AwsSolutions-SMG4",
                    reason="Automatic rotation not required for this internal admin dashboard password."
                )
            ]
        )
