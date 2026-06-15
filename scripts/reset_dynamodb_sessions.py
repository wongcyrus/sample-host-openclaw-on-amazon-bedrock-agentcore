import boto3
import sys

def reset_dynamodb_sessions(env_suffix="dev"):
    cf = boto3.client('cloudformation')
    stack_name = f"OpenClawRouter-{env_suffix}"
    
    print(f"Finding IdentityTable for stack: {stack_name}...")
    try:
        resp = cf.describe_stacks(StackName=stack_name)
        outputs = {o['OutputKey']: o['OutputValue'] for o in resp['Stacks'][0].get('Outputs', [])}
        table_name = outputs.get('IdentityTableName')
    except Exception as e:
        print(f"Error describing stack {stack_name}. Details: {e}")
        return

    if not table_name:
        print("IdentityTableName output not found in stack.")
        return

    print(f"Found DynamoDB table: {table_name}")
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(table_name)
    
    print("Scanning for SESSION records...")
    
    # We only want items where SK == 'SESSION'
    # The scan filter will match the Sort Key
    from boto3.dynamodb.conditions import Attr
    
    response = table.scan(
        FilterExpression=Attr('SK').eq('SESSION')
    )
    items = response.get('Items', [])
    
    while 'LastEvaluatedKey' in response:
        response = table.scan(
            FilterExpression=Attr('SK').eq('SESSION'),
            ExclusiveStartKey=response['LastEvaluatedKey']
        )
        items.extend(response.get('Items', []))

    if not items:
        print("No active SESSION records found in DynamoDB.")
        return

    print(f"Found {len(items)} session records in DynamoDB to delete. Deleting now...")
    
    with table.batch_writer() as batch:
        for item in items:
            batch.delete_item(
                Key={
                    'PK': item['PK'],
                    'SK': item['SK']
                }
            )
            print(f"Deleted session record for {item['PK']}")

    print("Successfully deleted all DynamoDB session records! OpenClaw router will generate fresh sessions on next message.")

if __name__ == '__main__':
    env = sys.argv[1] if len(sys.argv) > 1 else "dev"
    reset_dynamodb_sessions(env)
