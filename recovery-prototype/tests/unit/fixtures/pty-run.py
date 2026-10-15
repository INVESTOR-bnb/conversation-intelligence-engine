# Test helper: runs a command under a REAL pseudo-terminal (like the Codespaces terminal),
# typing the given inputs with pauses, and prints everything that appeared on the "screen".
# argv: JSON command list, JSON list of [seconds-to-wait-before, text-to-type].
import json, os, pty, select, sys, time
cmd, steps = json.loads(sys.argv[1]), json.loads(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(cmd[0], cmd, os.environ)
screen = b''
def drain(seconds):
    global screen
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                return
            if not chunk:
                return
            screen += chunk
for wait, text in steps:
    drain(wait)
    os.write(fd, text.encode())
drain(4)
try:
    os.kill(pid, 9)
except OSError:
    pass
sys.stdout.write(screen.decode(errors='replace'))
