# TOOLS.md - Local Notes

Keep setup-specific details for this robot here:

- Camera names and calibration notes
- Room names and landmark names
- Voice preferences
- Safety notes for this specific physical unit

## Core Tooling

- **humanoid** is the primary skill for `robot_4`
- Use it for movement, gestures, speech, vision, and capture functions
- Prefer safe actions such as stand, wave, or observe before longer motion sequences
- Do not invent robot IDs — always use the current workspace robot ID