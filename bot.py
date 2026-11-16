"""A small private-chat Telegram bot for RR Bot Academy."""

import argparse
from getpass import getpass
import json
import re
from time import monotonic
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


MENU = {
    "inline_keyboard": [[{"text": "محصولات", "callback_data": "catalog"}]],
}


class TelegramError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(f"Telegram API error ({code})")


def telegram(token, method, **params):
    request = Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=json.dumps(params).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urlopen(request, timeout=20) as response:
            data = json.load(response)
    except HTTPError as error:
        raise TelegramError(error.code) from None
    except (URLError, OSError, ValueError):
        raise TelegramError("network") from None
    if not data["ok"]:
        raise TelegramError(data.get("error_code", "unknown"))
    return data["result"]


def handle_update(update, api):
    if query := update.get("callback_query"):
        api("answerCallbackQuery", callback_query_id=query["id"])
        chat = query.get("message", {}).get("chat", {})
        if chat.get("type") == "private" and query.get("data") == "catalog":
            api("sendMessage", chat_id=chat["id"], text="محصول نمونه: دفتر یادداشت")
        return

    message = update.get("message", {})
    chat = message.get("chat", {})
    if chat.get("type") != "private":
        return
    text = message.get("text", "").split(maxsplit=1)
    if text and text[0] == "/start":
        api("sendMessage", chat_id=chat["id"], text="به فروشگاه تمرینی خوش اومدی!",
            reply_markup=MENU)


def run_bot(token, duration=None):
    if not re.fullmatch(r"[0-9]+:[A-Za-z0-9_-]+", token):
        print("توکن معتبر نیست. توکن همان ربات آزمایشی را از BotFather کپی کن.")
        return 1

    def api(method, **params):
        return telegram(token, method, **params)

    try:
        bot = api("getMe")
        if api("getWebhookInfo").get("url"):
            print("این ربات webhook فعال دارد. از یک ربات آزمایشی جدا استفاده کن.")
            return 1
        print(f"Started @{bot['username']} — در تلگرام /start را بفرست.", flush=True)
        deadline = monotonic() + duration if duration else None
        offset = 0
        while deadline is None or monotonic() < deadline:
            for update in api("getUpdates", offset=offset, timeout=10,
                              allowed_updates=["message", "callback_query"]):
                handle_update(update, api)
                offset = update["update_id"] + 1
    except KeyboardInterrupt:
        pass
    except TelegramError as error:
        reason = {
            401: "تلگرام توکن را نپذیرفت. توکن ربات آزمایشی را بررسی کن.",
            404: "نشانی API در دسترس نیست. توکن ربات را بررسی کن.",
            409: "این ربات در محیط دیگری اجراست. اول اجرای قبلی را متوقف کن.",
            "network": "اتصال به تلگرام برقرار نشد. اینترنت محیط اجرا را بررسی کن.",
        }
        print(reason.get(error.code, f"خطای تلگرام ({error.code})."))
        return 1
    print("اجرای ربات متوقف شد.")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo", action="store_true", help="run a token-free offline example")
    options = parser.parse_args()
    if options.demo:
        example = {"message": {"chat": {"type": "private", "id": 1}, "text": "/start"}}
        handle_update(example, lambda method, **params: print(
            json.dumps({"method": method, **params}, ensure_ascii=False, indent=2)
        ))
        return 0
    return run_bot(getpass("توکن ربات آزمایشی: ").strip())


if __name__ == "__main__":
    raise SystemExit(main())
