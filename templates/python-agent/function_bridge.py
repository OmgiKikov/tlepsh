#!/usr/bin/env python3
"""Connect an existing synchronous or async function: module:function(text) -> str.

Example manifest argv: [python3, function_bridge.py, my_agent:respond]
The original function owns its model calls and conversation state. Each case
gets a new process. This bridge reports only its final answer, never invented
tool calls, model usage, or cost. Use the full protocol for host-brokered tools.
"""

import asyncio
import contextlib
import importlib
import inspect
import json
import os
import re
import sys

PROTOCOL = int(os.environ.get("AHDE_PROTOCOL", "2"))


def send(message):
    sys.stdout.write(json.dumps({"v": PROTOCOL, **message}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    if PROTOCOL not in (1, 2):
        raise ValueError("AHDE_PROTOCOL must be 1 or 2")
    entry = sys.argv[1] if len(sys.argv) == 2 else ""
    if not re.fullmatch(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*", entry):
        send({"type": "error", "message": "Expected module:function, for example my_agent:respond"})
        return 1
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        # Libraries may print during import or execution. Keep stdout solely
        # for protocol frames so diagnostics cannot become an agent answer.
        with contextlib.redirect_stdout(sys.stderr):
            module, name = entry.split(":")
            respond = getattr(importlib.import_module(module), name)
            if not callable(respond):
                raise TypeError("The selected entry point is not a function")
            inspect.signature(respond).bind("message")
        for line in sys.stdin:
            if not line.strip():
                continue
            message = json.loads(line)
            if message.get("v") != PROTOCOL:
                raise ValueError("Message version differs from AHDE_PROTOCOL")
            if message.get("type") == "cancel":
                return 0
            if message.get("type") == "hello":
                continue
            if message.get("type") != "user":
                raise ValueError("This bridge accepts hello, user and cancel frames only")
            with contextlib.redirect_stdout(sys.stderr):
                reply = respond(message["text"])
                if inspect.isawaitable(reply):
                    reply = loop.run_until_complete(reply)
            if not isinstance(reply, str):
                raise TypeError("The function must return a string answer")
            send({"type": "assistant", "turn": message["turn"], "text": reply})
    except Exception as error:
        send({"type": "error", "message": f"{type(error).__name__}: {error}"})
        return 1
    finally:
        loop.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
