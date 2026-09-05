#!/usr/bin/env python3
"""Агент первой линии поддержки интернет-провайдера. Протокол AHDE v1.

Одна программа на стандартной библиотеке. AHDE запускает её один раз на прогон,
присылает `hello` с описанием инструментов и модели, а дальше — по одной реплике
пользователя. Ответ агента заканчивает ход.

Всё, что печатается в stdout, — это протокол. Диагностика идёт в stderr: любая
посторонняя строка в stdout будет нарушением протокола, и прогон остановится.

Правила поведения агента живут не здесь, а в prompts/system.md — это и есть
editable surface, объявленный в manifest.yaml (`harness.files`). Улучшать агента
значит править этот файл, а не этот.
"""

import json
import os
import socket
import sys
import urllib.error
import urllib.request

PROTOCOL = 1
MAX_STEPS = 8  # столько раз за один ход агент может сходить в инструмент


def log(text):
    print(text, file=sys.stderr, flush=True)


def send(message):
    """Одна строка протокола. Больше в stdout не попадает ничего."""
    sys.stdout.write(json.dumps({"v": PROTOCOL, **message}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def read_message():
    line = sys.stdin.readline()
    if not line:
        return None
    line = line.strip()
    return read_message() if not line else json.loads(line)


def system_prompt():
    """Документы возвращает kb_search из hello; весь корпус в промпт не копируем."""
    with open(os.path.join("prompts", "system.md"), encoding="utf-8") as handle:
        return handle.read().strip()


def openai_tools(declared):
    """Инструменты из `hello` в формате запроса OpenAI-совместимого эндпоинта."""
    return [
        {
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool["description"],
                "parameters": tool["parameters"],
            },
        }
        for tool in declared
    ]


def prefer_ipv4(getaddrinfo):
    """IPv4-адреса вперёд.

    Внутри песочницы хост может отдавать IPv6-адрес первым, а маршрута в
    глобальный IPv6 у машины нет: соединение зависает в SYN_SENT до таймаута
    ядра (~75 с) на каждый вызов и съедает весь бюджет хода. Снаружи то же
    соединение падает мгновенно и urllib берёт IPv4. Порядок адресов — не
    политика агента, поэтому меняем только его, не список.
    """

    def ordered(*args, **kwargs):
        results = getaddrinfo(*args, **kwargs)
        return sorted(results, key=lambda entry: 0 if entry[0] == socket.AF_INET else 1)

    return ordered


socket.getaddrinfo = prefer_ipv4(socket.getaddrinfo)


def complete(model, tools, messages):
    """Один запрос к чат-эндпоинту. Ключ берётся из переменной, названной в hello."""
    key = os.environ.get(model["apiKeyEnv"], "")
    payload = {"model": model["id"], "messages": messages, "stream": False}
    if tools:
        payload["tools"] = tools
    request = urllib.request.Request(
        model["baseUrl"].rstrip("/") + "/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def usage_of(body, turn):
    raw = body.get("usage") or {}
    prompt = int(raw.get("prompt_tokens", 0))
    completion = int(raw.get("completion_tokens", 0))
    total = int(raw.get("total_tokens", prompt + completion))
    if prompt == 0 and completion == 0 and total == 0:
        # Эндпоинт ничего не сообщил. Ноль — это утверждение, поэтому молчим:
        # AHDE запишет расход как ОТСУТСТВУЮЩИЙ, а не как бесплатный прогон.
        return None
    return {
        "type": "usage",
        "turn": turn,
        "tokens": {
            "input": prompt,
            "output": completion,
            "cacheRead": 0,
            "cacheWrite": 0,
            "total": total,
        },
    }


def take_turn(state, message):
    """Один ход: реплика пользователя, сколько-то инструментов, один ответ."""
    turn = message["turn"]
    state["history"].append({"role": "user", "content": message["text"]})
    for _ in range(MAX_STEPS):
        body = complete(state["model"], state["tools"], state["history"])
        # Каждый запрос оплачивается, включая запросы выбора инструмента.
        usage = usage_of(body, turn)
        if usage:
            send(usage)
        choice = (body.get("choices") or [{}])[0].get("message") or {}
        calls = choice.get("tool_calls") or []
        if not calls:
            text = choice.get("content") or ""
            state["history"].append({"role": "assistant", "content": text})
            send({"type": "assistant", "turn": turn, "text": text})
            return
        state["history"].append({"role": "assistant", "content": choice.get("content") or "", "tool_calls": calls})
        for call in calls:
            name = call["function"]["name"]
            try:
                arguments = json.loads(call["function"].get("arguments") or "{}")
            except json.JSONDecodeError:
                arguments = {}
            # Инструмент выполняет ХОЗЯИН, в своей песочнице. Агент только просит.
            send({"type": "tool_call", "id": call["id"], "name": name, "arguments": arguments})
            result = read_message()
            if result is None or result.get("type") != "tool_result":
                send({"type": "error", "message": "ожидался tool_result"})
                return
            state["history"].append({"role": "tool", "tool_call_id": call["id"], "content": result["text"]})
    send({"type": "error", "message": "агент не дошёл до ответа за {} шагов".format(MAX_STEPS)})


def main():
    state = {"model": None, "tools": [], "history": []}
    while True:
        try:
            message = read_message()
        except json.JSONDecodeError as error:
            send({"type": "error", "message": "хост прислал не JSON: {}".format(error)})
            return 1
        if message is None or message.get("type") == "cancel":
            return 0
        kind = message.get("type")
        if kind == "hello":
            state["model"] = message["model"]
            state["tools"] = openai_tools(message.get("tools") or [])
            state["history"] = [{"role": "system", "content": system_prompt()}]
            log("готов: модель {}, инструментов {}".format(state["model"]["id"], len(state["tools"])))
        elif kind == "user":
            try:
                take_turn(state, message)
            except (urllib.error.URLError, OSError, KeyError, ValueError) as error:
                send({"type": "error", "message": "{}: {}".format(type(error).__name__, error)})
                return 1


if __name__ == "__main__":
    sys.exit(main())
