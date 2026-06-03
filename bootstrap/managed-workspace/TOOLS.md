# TOOLS.md - Local Notes

Skills define how tools work. This file is for your local specifics — the stuff unique to your setup.

## What Goes Here

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker and room names
- Device nicknames
- Any environment-specific note that should not live in shared skill code

## Runtime Tools

- **web_search** and **web_fetch** for current information
- **s3-user-files** for persistent namespace storage
- **eventbridge-cron** for schedules and reminders
- **clawhub-manage** for community skill install/uninstall/list
- **api-keys** for secure key storage
- **humanoid** for robot control through the robot agents

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes.