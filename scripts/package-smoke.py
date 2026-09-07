"""Exercise the packaged CLI in a real terminal with Node and Git on PATH."""

import errno
import fcntl
import os
import pty
import re
import select
import subprocess
import struct
import sys
import time
import termios

entrypoint, fixture, binary_directory = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
environment = dict(os.environ, PATH=binary_directory, TERM="xterm", NO_COLOR="1")
process = subprocess.Popen(
    [entrypoint, "--cwd", fixture], stdin=slave, stdout=slave, stderr=slave,
    env=environment, close_fds=True,
)
os.close(slave)
transcript = ""
cursor = 0
ansi = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def read_output(timeout):
    global transcript
    if select.select([master], [], [], timeout)[0]:
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                return False
            raise
        if not data:
            return False
        transcript += data.decode("utf-8", errors="replace")
    return True


def respond(prompt, response="\r"):
    global cursor
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        plain = ansi.sub("", transcript)
        index = plain.find(prompt, cursor)
        if index >= 0:
            cursor = index + len(prompt)
            os.write(master, response.encode())
            return
        if not read_output(0.1) and process.poll() is not None:
            break
    raise RuntimeError("Prompt missing: " + prompt)


try:
    for prompt in [
        "Where should the pipeline run?",
        "Which branches should run the pipeline?", "Additional branches", "App name",
        "Container registry hostname",
        "npm version for builds", "Node.js version for builds", "Build command",
        "Build output folder", "Build platform",
        "How should the pipeline deliver your app?",
        "Browser environment variable names",
        "Environment name for main", "Override build variables with an Azure Secure File for main?",
        "Environment name for staging", "Override build variables with an Azure Secure File for staging?",
        "Environment name for develop", "Override build variables with an Azure Secure File for develop?",
    ]:
        respond(prompt)
    respond("Apply these changes to", "y\r")
    respond("Create a local Git commit with these changes?")
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and process.poll() is None:
        read_output(0.1)
    if process.wait(timeout=2) != 0:
        raise RuntimeError("Packaged CLI returned a failure")
except Exception:
    print(ansi.sub("", transcript), file=sys.stderr)
    raise
finally:
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=3)
    os.close(master)
