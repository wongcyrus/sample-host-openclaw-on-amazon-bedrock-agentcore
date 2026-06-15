import boto3

def stop_active_sessions():
    client = boto3.client('bedrock-agent-runtime')
    
    print("Fetching Bedrock AgentCore sessions...")
    
    paginator = client.get_paginator('list_sessions')
    
    active_sessions = []
    
    try:
        for page in paginator.paginate():
            for session in page.get('sessionSummaries', []):
                if session.get('sessionStatus') == 'ACTIVE':
                    active_sessions.append(session['sessionId'])
    except Exception as e:
        print(f"Error fetching sessions: {e}")
        return

    if not active_sessions:
        print("No ACTIVE sessions found. Everything is already stopped!")
        return

    print(f"Found {len(active_sessions)} ACTIVE sessions. Stopping them now...")
    
    stopped_count = 0
    for session_id in active_sessions:
        try:
            client.end_session(sessionIdentifier=session_id)
            print(f"Stopped session: {session_id}")
            stopped_count += 1
        except Exception as e:
            print(f"Failed to stop session {session_id}: {e}")
            
    print(f"Successfully stopped {stopped_count} active sessions.")

if __name__ == '__main__':
    stop_active_sessions()
