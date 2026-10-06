import os
from pathlib import Path
import subprocess


def test_follower_reads_env_actor_and_preserves_explicit_override(tmp_path):
    script = Path(__file__).resolve().parents[1] / "scripts/follow-openclaw-logs.sh"
    env_file = tmp_path / ".env.dev"
    env_file.write_text("OPENCLAW_ENV_SUFFIX=dev\nE2E_TELEGRAM_USER_ID='123,456'\n")
    runner = tmp_path / "fake-python"
    runner.write_text("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CAPTURE_ARGS\"\nexit 1\n")
    runner.chmod(0o700)
    capture = tmp_path / "args"
    env = {
        **os.environ, "OPENCLAW_ENV_FILE": str(env_file),
        "OPENCLAW_PYTHON": str(runner), "CAPTURE_ARGS": str(capture),
    }
    for extra, expected in [([], "telegram:123"), (["--actor-id", "slack:test"], "slack:test")]:
        result = subprocess.run(
            ["bash", str(script), "--env", "dev", *extra],
            env=env, capture_output=True, text=True,
        )
        assert result.returncode == 1
        args = capture.read_text().splitlines()
        assert args[args.index("--actor-id") + 1] == expected
        assert args.count("--actor-id") == 1
        output = Path(args[args.index("--output") + 1])
        assert not output.parent.exists()
