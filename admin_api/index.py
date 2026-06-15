import json
import os
import boto3
import time
import base64
from botocore.exceptions import ClientError

IDENTITY_TABLE = os.environ.get('IDENTITY_TABLE_NAME')
BUCKET_NAME = os.environ.get('USER_FILES_BUCKET_NAME')
ADMIN_SECRET_ARN = os.environ.get('ADMIN_SECRET_ARN')

_ADMIN_PASSWORD = None

def get_admin_password():
    global _ADMIN_PASSWORD
    if not _ADMIN_PASSWORD:
        client = boto3.client('secretsmanager')
        try:
            _ADMIN_PASSWORD = client.get_secret_value(SecretId=ADMIN_SECRET_ARN)['SecretString']
        except Exception as e:
            print(f"Failed to fetch admin password: {e}")
            _ADMIN_PASSWORD = "error_fetching_secret"
    return _ADMIN_PASSWORD

def handler(event, context):
    # Basic Authentication
    auth_header = event.get('headers', {}).get('authorization', '')
    expected_auth = 'Basic ' + base64.b64encode(f"admin:{get_admin_password()}".encode()).decode()
    
    if auth_header != expected_auth:
        return {
            'statusCode': 401,
            'headers': {'WWW-Authenticate': 'Basic realm="Admin Dashboard"'},
            'body': 'Unauthorized'
        }

    path = event.get('rawPath', '/')
    method = event.get('requestContext', {}).get('http', {}).get('method', 'GET')
    
    if path == '/' and method == 'GET':
        # Serve the HTML frontend
        with open('index.html', 'r') as f:
            html = f.read()
        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'text/html'},
            'body': html
        }
        
    elif path == '/api/sessions' and method == 'GET':
        return get_sessions()
        
    elif path.startswith('/api/session/end/user/') and method == 'POST':
        user_id = path.replace('/api/session/end/user/', '')
        return end_user_session(user_id)
        
    elif path.startswith('/api/session/unlock/user/') and method == 'POST':
        user_id = path.replace('/api/session/unlock/user/', '')
        return clean_user_locks(user_id)
        
    elif path == '/api/reset/global' and method == 'POST':
        return global_reset()
        
    return {
        'statusCode': 404,
        'body': json.dumps({'error': 'Not found'})
    }

def get_sessions():
    # Get pointers from DynamoDB
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(IDENTITY_TABLE)
    
    from boto3.dynamodb.conditions import Attr
    try:
        response = table.scan(FilterExpression=Attr('SK').eq('SESSION'))
        items = response.get('Items', [])
        while 'LastEvaluatedKey' in response:
            response = table.scan(
                FilterExpression=Attr('SK').eq('SESSION'),
                ExclusiveStartKey=response['LastEvaluatedKey']
            )
            items.extend(response.get('Items', []))
            
        sessions = []
        for item in items:
            sessions.append({
                'userId': item['PK'].replace('USER#', ''),
                'sessionId': item['sessionId'],
                'status': 'ACTIVE (tracked)'
            })
        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps(sessions)
        }
    except Exception as e:
        return {'statusCode': 500, 'body': json.dumps({'error': str(e)})}

AGENTCORE_RUNTIME_ARN_PARAMETER = os.environ.get("AGENTCORE_RUNTIME_ARN_PARAMETER")
AGENTCORE_QUALIFIER_PARAMETER = os.environ.get("AGENTCORE_QUALIFIER_PARAMETER")

def _get_runtime_config():
    ssm_client = boto3.client('ssm')
    try:
        arn_param = ssm_client.get_parameter(Name=AGENTCORE_RUNTIME_ARN_PARAMETER)["Parameter"]["Value"]
        qual_param = ssm_client.get_parameter(Name=AGENTCORE_QUALIFIER_PARAMETER)["Parameter"]["Value"]
        return arn_param, qual_param
    except Exception as e:
        print(f"Failed to fetch runtime config: {e}")
        return None, None

def end_user_session(user_id):
    agentcore = boto3.client('bedrock-agentcore')
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(IDENTITY_TABLE)
    
    try:
        response = table.get_item(Key={'PK': f'USER#{user_id}', 'SK': 'SESSION'})
        item = response.get('Item')
        if item:
            session_id = item['sessionId']
            runtime_arn, qualifier = _get_runtime_config()
            if runtime_arn and qualifier:
                try:
                    agentcore.stop_runtime_session(
                        runtimeSessionId=session_id,
                        agentRuntimeArn=runtime_arn,
                        qualifier=qualifier
                    )
                except Exception as e:
                    print(f"Warning: Failed to stop AgentCore session {session_id} (it may have already expired): {e}")
            
            # Delete the proxy session mapping
            table.delete_item(Key={'PK': f'USER#{user_id}', 'SK': 'SESSION'})
            
        return {'statusCode': 200, 'body': json.dumps({'success': True})}
    except Exception as e:
        return {'statusCode': 500, 'body': json.dumps({'error': str(e)})}

def clean_user_locks(user_id):
    try:
        # Clean orphaned locks in S3 (keeping global lock wipe for now, could be scoped to user if prefix used)
        _clean_locks_in_s3()
        return {'statusCode': 200, 'body': json.dumps({'success': True})}
    except Exception as e:
        return {'statusCode': 500, 'body': json.dumps({'error': str(e)})}

def global_reset():
    agentcore = boto3.client('bedrock-agentcore')
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(IDENTITY_TABLE)
    
    try:
        # 1. Get all session pointers from DynamoDB
        from boto3.dynamodb.conditions import Attr
        response = table.scan(FilterExpression=Attr('SK').eq('SESSION'))
        items = response.get('Items', [])
        while 'LastEvaluatedKey' in response:
            response = table.scan(
                FilterExpression=Attr('SK').eq('SESSION'),
                ExclusiveStartKey=response['LastEvaluatedKey']
            )
            items.extend(response.get('Items', []))
            
        runtime_arn, qualifier = _get_runtime_config()
        
        # 2. End all active AgentCore sessions
        if runtime_arn and qualifier:
            for item in items:
                session_id = item['sessionId']
                try:
                    agentcore.stop_runtime_session(
                        runtimeSessionId=session_id,
                        agentRuntimeArn=runtime_arn,
                        qualifier=qualifier
                    )
                except Exception:
                    pass
        with table.batch_writer() as batch:
            for item in items:
                batch.delete_item(Key={'PK': item['PK'], 'SK': item['SK']})
                
        # 3. Wipe user workspaces in S3 (keeping workspace-bootstrap)
        s3 = boto3.client('s3')
        paginator = s3.get_paginator('list_objects_v2')
        objects_to_delete = []
        for page in paginator.paginate(Bucket=BUCKET_NAME):
            if 'Contents' not in page: continue
            for obj in page['Contents']:
                key = obj['Key']
                if not key.startswith('workspace-bootstrap/'):
                    objects_to_delete.append({'Key': key})
                    
        for i in range(0, len(objects_to_delete), 1000):
            s3.delete_objects(Bucket=BUCKET_NAME, Delete={'Objects': objects_to_delete[i:i+1000], 'Quiet': True})
        
        return {'statusCode': 200, 'body': json.dumps({'success': True})}
    except Exception as e:
        return {'statusCode': 500, 'body': json.dumps({'error': str(e)})}

def _clean_locks_in_s3():
    s3 = boto3.client('s3')
    paginator = s3.get_paginator('list_objects_v2')
    objects_to_delete = []
    for page in paginator.paginate(Bucket=BUCKET_NAME):
        if 'Contents' not in page: continue
        for obj in page['Contents']:
            key = obj['Key']
            if '/sessions/' in key:
                objects_to_delete.append({'Key': key})
    for i in range(0, len(objects_to_delete), 1000):
        s3.delete_objects(Bucket=BUCKET_NAME, Delete={'Objects': objects_to_delete[i:i+1000], 'Quiet': True})
