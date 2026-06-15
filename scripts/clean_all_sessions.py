import boto3
import sys

def clean_all_sessions(env_suffix="dev"):
    cf = boto3.client('cloudformation')
    stack_name = f"OpenClawAgentCore-{env_suffix}"
    
    print(f"Finding UserFilesBucket for stack: {stack_name}...")
    try:
        resp = cf.describe_stacks(StackName=stack_name)
        outputs = {o['OutputKey']: o['OutputValue'] for o in resp['Stacks'][0].get('Outputs', [])}
        bucket_name = outputs.get('UserFilesBucketName')
    except Exception as e:
        print(f"Error describing stack {stack_name}. Ensure you have the correct AWS credentials and env suffix.")
        print(f"Details: {e}")
        return

    if not bucket_name:
        print("UserFilesBucketName output not found in stack.")
        return

    print(f"Found bucket: {bucket_name}")
    s3 = boto3.client('s3')
    paginator = s3.get_paginator('list_objects_v2')
    
    objects_to_delete = []
    
    print("Scanning for session files across all users and agents...")
    for page in paginator.paginate(Bucket=bucket_name):
        if 'Contents' not in page:
            continue
        for obj in page['Contents']:
            key = obj['Key']
            # Target any file located inside a 'sessions/' folder
            if '/sessions/' in key:
                objects_to_delete.append({'Key': key})

    if not objects_to_delete:
        print("No session files found. Everything is already clean!")
        return

    print(f"Found {len(objects_to_delete)} session files (including stale locks) to delete.")
    
    # Delete in batches of 1000 (S3 limit per request)
    for i in range(0, len(objects_to_delete), 1000):
        batch = objects_to_delete[i:i+1000]
        s3.delete_objects(
            Bucket=bucket_name,
            Delete={'Objects': batch, 'Quiet': True}
        )
        print(f"Deleted batch of {len(batch)} files...")
        
    print("Successfully cleaned all sessions!")

if __name__ == '__main__':
    # Default to 'dev' unless an environment is provided
    env = sys.argv[1] if len(sys.argv) > 1 else "dev"
    clean_all_sessions(env)
