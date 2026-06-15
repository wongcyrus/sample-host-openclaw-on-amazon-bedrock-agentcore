import boto3
import sys

def delete_all_log_streams():
    ec2 = boto3.client('ec2', region_name='us-east-1')
    try:
        regions = [region['RegionName'] for region in ec2.describe_regions()['Regions']]
    except Exception as e:
        print(f"Could not describe regions: {e}")
        regions = [boto3.session.Session().region_name or 'us-east-1']

    for region in regions:
        print(f"--- Checking region: {region} ---")
        logs = boto3.client('logs', region_name=region)
        try:
            paginator_groups = logs.get_paginator('describe_log_groups')
            for page_groups in paginator_groups.paginate():
                for group in page_groups['logGroups']:
                    group_name = group['logGroupName']
                    print(f"  Log Group: {group_name}")
                    
                    try:
                        # Fetch all log streams for this group
                        paginator_streams = logs.get_paginator('describe_log_streams')
                        streams_iterator = paginator_streams.paginate(logGroupName=group_name)
                        for page_streams in streams_iterator:
                            for stream in page_streams['logStreams']:
                                stream_name = stream['logStreamName']
                                print(f"    Deleting stream: {stream_name}")
                                try:
                                    logs.delete_log_stream(
                                        logGroupName=group_name,
                                        logStreamName=stream_name
                                    )
                                except Exception as e:
                                    print(f"      Error deleting stream: {e}")
                    except Exception as e:
                        print(f"    Error processing streams for group {group_name}: {e}")
        except Exception as e:
            print(f"Error accessing log groups in region {region}: {e}")

if __name__ == '__main__':
    delete_all_log_streams()
