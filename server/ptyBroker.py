"""A pty on stdio, because Bun cannot make one.

node-pty loads under Bun and then silently reads nothing, and `script` wants a real
tty on its own stdin, which a pipe is not. So the dashboard spawns this: it owns the
pty master, execs the command on the slave, and shuttles bytes over its own stdin and
stdout. The parent only has to move bytes between here and a WebSocket.

Protocol on stdin: raw bytes are keystrokes, except a frame starting with \\x00 and
ending in a newline, which is JSON — {"type":"resize","cols":N,"rows":N}. That is the
same frame the browser already sends, so it passes straight through.

Usage: ptyBroker.py <cols> <rows> <argv...>
"""

import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios

READ_SIZE = 65536


def set_winsize(fd: int, cols: int, rows: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", max(5, rows), max(20, cols), 0, 0))


def main() -> int:
    if len(sys.argv) < 4:
        print("usage: ptyBroker.py <cols> <rows> <argv...>", file=sys.stderr)
        return 2

    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    argv = sys.argv[3:]

    # pty.fork rather than openpty: the child gets setsid() and TIOCSCTTY for free,
    # and without a controlling terminal there is no foreground process group for
    # SIGWINCH, so tmux would never notice a resize.
    pid, master = pty.fork()
    if pid == 0:
        os.environ["TERM"] = os.environ.get("TERM", "xterm-256color")
        try:
            os.execvp(argv[0], argv)
        except OSError as exc:
            sys.stderr.write(f"{argv[0]}: {exc}\n")
        os._exit(127)

    set_winsize(master, cols, rows)
    os.kill(pid, signal.SIGWINCH)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    pending = b""

    try:
        while True:
            try:
                readable, _, _ = select.select([master, stdin_fd], [], [])
            except (OSError, ValueError, InterruptedError):
                break

            if master in readable:
                try:
                    data = os.read(master, READ_SIZE)
                except OSError:
                    data = b""
                if not data:
                    break
                # Blocking: a slow consumer holds the program back rather than
                # letting a noisy pane buffer without limit in this process.
                os.write(stdout_fd, data)

            if stdin_fd in readable:
                try:
                    chunk = os.read(stdin_fd, READ_SIZE)
                except OSError:
                    chunk = b""
                if not chunk:
                    break
                pending = handle_input(master, pid, pending + chunk)
    finally:
        try:
            os.killpg(os.getpgid(pid), signal.SIGHUP)
        except (ProcessLookupError, PermissionError, OSError):
            # Already gone; macOS answers EPERM for a group holding only a zombie.
            pass
        try:
            os.close(master)
        except OSError:
            pass
        try:
            os.waitpid(pid, 0)
        except (ChildProcessError, OSError):
            pass
    return 0


def handle_input(master: int, pid: int, buf: bytes) -> bytes:
    """Writes keystrokes through and acts on control frames. Returns what is left."""
    while True:
        start = buf.find(b"\x00")
        if start == -1:
            if buf:
                os.write(master, buf)
            return b""
        if start:
            os.write(master, buf[:start])
            buf = buf[start:]
            continue
        end = buf.find(b"\n")
        if end == -1:
            # A partial control frame: hold it until the rest arrives.
            return buf
        try:
            msg = json.loads(buf[1:end])
            if msg.get("type") == "resize":
                set_winsize(master, int(msg.get("cols", 80)), int(msg.get("rows", 24)))
                os.kill(pid, signal.SIGWINCH)
        except (ValueError, KeyError, OSError, ProcessLookupError):
            pass
        buf = buf[end + 1 :]


if __name__ == "__main__":
    sys.exit(main())
