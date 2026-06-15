#!/usr/bin/env bash
set -e

ENV=${1:-dev}
echo "Starting hard reset for environment: $ENV"

# Ensure we are using the python virtual environment
if [ -d ".venv" ]; then
    source .venv/bin/activate
fi

echo ""
echo "=== 1. Stopping Active Bedrock Sessions ==="
python scripts/stop_bedrock_sessions.py

echo ""
echo "=== 2. Resetting DynamoDB Session Pointers ==="
python scripts/reset_dynamodb_sessions.py $ENV

echo ""
echo "=== 2.5. Waiting for Container Termination ==="
echo "Sleeping 30 seconds to allow the Bedrock AgentCore containers to fully terminate."
echo "If we delete S3 files too early, the dying containers will just sync their corrupted files back to S3 on shutdown!"
sleep 30

echo ""
echo "=== 3. Clearing User Workspaces in S3 ==="
STACK_NAME="OpenClawAgentCore-$ENV"
BUCKET_NAME=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --query "Stacks[0].Outputs[?OutputKey=='UserFilesBucketName'].OutputValue" --output text || echo "")

if [ -z "$BUCKET_NAME" ] || [ "$BUCKET_NAME" == "None" ]; then
    echo "Could not find S3 bucket for stack $STACK_NAME. Skipping S3 wipe."
else
    echo "Found bucket: $BUCKET_NAME"
    echo "Wiping all individual user workspaces to force a clean slate..."
    # This deletes all user-specific folders (e.g. telegram_12345/) but leaves the global bootstrap folder intact
    aws s3 rm s3://$BUCKET_NAME/ --recursive --exclude "workspace-bootstrap/*"
    
    echo ""
    echo "=== 4. Restoring Initial Bootstrap Files ==="
    echo "Syncing local bootstrap/managed-workspace/ up to S3 workspace-bootstrap/..."
    aws s3 sync bootstrap/managed-workspace/ s3://$BUCKET_NAME/workspace-bootstrap/
fi

echo ""
echo "✅ Hard reset complete! All agents will cold-start with fresh bootstrap files on their next message."
