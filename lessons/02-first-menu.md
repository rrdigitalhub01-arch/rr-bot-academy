# درس ۲ | اولین منوی ربات تلگرام

شمارهٔ روی ویدیو را در جدول پیدا کن و همان قدم را انجام بده.

| قدم | کاری که همراه ویدیو انجام می‌دهی |
| --- | --- |
| [۱](#step-1) | پیش‌نیازها را آماده کن |
| [۲](#step-2) | گوگل کولب را باز کن |
| [۳](#step-3) | کد پایتون را کپی و اجرا کن |
| [۴](#step-4) | توکن را وارد کن و نام ربات را ببین |
| [۵](#step-5) | در تلگرام منو را امتحان کن |

<a name="step-1"></a>

## قدم ۱ — پیش‌نیازها

روی گوشی به اینترنت، مرورگر، تلگرام و یک حساب گوگل نیاز داری. ربات آزمایشی و توکن آن را از [درس ۱](01-create-bot.md) آماده کن. توکن همان کدی است که BotFather بعد از ساخت ربات به تو می‌دهد.

<a name="step-2"></a>

## قدم ۲ — گوگل کولب را باز کن

[یک صفحهٔ جدید در گوگل کولب باز کن](https://colab.new). اگر صفحهٔ ورود آمد، با حساب گوگل وارد شو. داخل صفحه باید یک کادر کد با دکمهٔ ▶ ببینی. صفحه را باز بگذار و برای کپی کد به همین درس برگرد.

<a name="step-3"></a>

## قدم ۳ — کد پایتون را کپی و اجرا کن

دکمهٔ کپی بالای کادر زیر را بزن تا **تمام کد** کپی شود. به کولب برگرد، داخل اولین کادر کد بچسبان و روی ▶ کنار همان کادر بزن. زیر کادر، ورودی توکن ظاهر می‌شود.

```python
# @title اجرای ربات آزمایشی { display-mode: "form" }
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


run_bot(getpass("توکن ربات آزمایشی: ").strip(), duration=120)
```

<a name="step-4"></a>

## قدم ۴ — توکن را وارد کن

توکن ربات آزمایشی را از BotFather بگیر و فقط در کادر مخفی زیر کد بچسبان. Enter را بزن. وقتی `Started @...` را دیدی، نام کاربری نمایش‌داده‌شده نام همان رباتی است که باید در تلگرام باز کنی.

<a name="step-5"></a>

## قدم ۵ — منو را در تلگرام امتحان کن

در چت خصوصی همان ربات این دستور را بفرست:

```text
/start
```

باید پیام خوش‌آمد و دکمهٔ **محصولات** را ببینی. روی دکمه بزن تا «محصول نمونه: دفتر یادداشت» ظاهر شود. فرصت تست حدود دو دقیقه است. برای تست دوباره ▶ و برای توقف زودتر دکمهٔ مربع را بزن.

[فایل آمادهٔ همین کد برای کولب](../notebooks/rr-first-bot.ipynb)

## اندروید | Termux

1. [Termux را از مسیر رسمی](https://github.com/termux/termux-app#installation) نصب و باز کن. هر خط را جداگانه اجرا کن.

   ```sh
   pkg update
   pkg install python git
   ```

   برای دیدن نسخه‌های نصب‌شده، این دو دستور را جداگانه بزن.

   ```sh
   python3 --version
   git --version
   ```

2. مخزن را بگیر، وارد پوشه شو و ربات را اجرا کن.

   ```sh
   git clone https://github.com/rrdigitalhub01-arch/rr-bot-academy.git
   cd rr-bot-academy
   python3 bot.py
   ```

3. توکن را در ورودی مخفی بچسبان و Enter بزن. پس از دیدن `Started @...` برنامه را باز نگه دار و ربات را در تلگرام امتحان کن. برای پایان در Termux کلید **Ctrl+C** را بزن.

## کامپیوتر | Python

1. در صفحهٔ اصلی مخزن از **Code → Download ZIP** فایل‌ها را بگیر و از حالت فشرده خارج کن.
2. ترمینال را در پوشه‌ای باز کن که فایل `bot.py` داخل آن است. با [Python 3.10 یا جدیدتر](https://www.python.org/downloads/) از دستور دستگاهت استفاده کن.

   لینوکس و macOS

   ```sh
   python3 --version
   python3 bot.py
   ```

   ویندوز

   ```powershell
   py -3 --version
   py -3 bot.py
   ```

3. توکن را در ورودی مخفی وارد کن. پس از دیدن `Started @...` به تلگرام برو. برای پایان در ترمینال **Ctrl+C** بزن.

## رفع خطا

برای تست هر دستگاه، [قدم ۵](#step-5) را انجام بده.

| اگر این را دیدی | راه‌حل |
| --- | --- |
| توکن هنگام ورود دیده نمی‌شود | ورودی مخفی است. یک بار توکن را بچسبان و Enter بزن. |
| تلگرام توکن را نمی‌پذیرد | نام ربات و توکن کامل را دوباره از BotFather بررسی کن. |
| `Started` را دیدی و ربات پاسخ نمی‌دهد | نام کاربری ربات را مقایسه کن، برنامه را در حال اجرا بگذار و یک `/start` تازه در چت خصوصی بفرست. |
| ربات جای دیگری در حال اجراست | اجرای قبلی را متوقف و فقط یک نمونه را روشن کن. |
| Colab به پایان رسید | سلول را دوباره اجرا کن و توکن را در کادر مخفی وارد کن. |

## دکمه در کد چطور کار می‌کند؟

۱. در [کد ربات](../bot.py) بخش `handle_update` پیام شروع را تشخیص می‌دهد و با `sendMessage` پیام خوش‌آمد را می‌فرستد.
۲. دکمهٔ «محصولات» در `MENU` تعریف شده و دادهٔ `catalog` را هنگام لمس دکمه به برنامه می‌فرستد.
۳. برنامه لمس دکمه را با `answerCallbackQuery` تأیید می‌کند و محصول نمونه را در چت نشان می‌دهد.

## تمرین

در [کد ربات](../bot.py) متن «دفتر یادداشت» را با محصول خودت جایگزین کن. برنامه را دوباره اجرا کن و با همان دکمه نتیجه را ببین. در Colab کد سلول را باز کن و همان متن را تغییر بده. پیش از اجرای دوباره، اجرای قبلی را متوقف کن. بعد از دیدن پیام شروع، دستور آغاز را دوباره در تلگرام بفرست و روی «محصولات» بزن.

[راهنمای رسمی API تلگرام](https://core.telegram.org/bots/api) · [صفحهٔ اصلی دوره](../README.md)
