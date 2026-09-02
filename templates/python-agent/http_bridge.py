#!/usr/bin/env python3
"""Мост к агенту, который уже живёт за HTTP (Langflow, n8n, свой сервис).

Отдельного `kind: http` в AHDE нет и не нужно: команда, которая пересылает
реплику по HTTP и возвращает ответ, — это и есть адаптер. Замените argv в
manifest.yaml на `[python3, http_bridge.py]` и укажите endpoint в
AHDE_BRIDGE_URL (объявите его в execution.environmentAllowlist).

Инструменты этот мост не брокерит: агент по ту сторону HTTP ходит за данными
сам, поэтому AHDE не считает его вызовы своими и не может их песочить.
"""

import json
import os
import sys
import urllib.request

URL = os.environ.get("AHDE_BRIDGE_URL", "")


def send(message):
    sys.stdout.write(json.dumps({"v": 1, **message}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def ask(text):
    request = urllib.request.Request(
        URL,
        data=json.dumps({"input": text}, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        body = json.loads(response.read().decode("utf-8"))
    return body.get("output") or body.get("text") or ""


def main():
    if not URL:
        send({"type": "error", "message": "AHDE_BRIDGE_URL не задан"})
        return 1
    for line in sys.stdin:
        if not line.strip():
            continue
        message = json.loads(line)
        if message.get("type") == "cancel":
            return 0
        if message.get("type") != "user":
            continue
        try:
            send({"type": "assistant", "turn": message["turn"], "text": ask(message["text"])})
        except Exception as error:  # noqa: BLE001 — любая сетевая беда это ошибка прогона
            send({"type": "error", "message": "{}: {}".format(type(error).__name__, error)})
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
