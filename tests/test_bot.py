import unittest
from unittest.mock import Mock, patch

from bot import MENU, TelegramError, handle_update, run_bot


class BotTests(unittest.TestCase):
    def setUp(self):
        self.api = Mock()
        self.chat = {"type": "private", "id": 42}

    def test_private_start_shows_products_button(self):
        handle_update({"message": {"chat": self.chat, "text": "/start"}}, self.api)
        self.api.assert_called_once_with(
            "sendMessage", chat_id=42, text="به فروشگاه تمرینی خوش اومدی!",
            reply_markup=MENU,
        )

    def test_products_callback_is_acknowledged_and_replies(self):
        handle_update({"callback_query": {
            "id": "sample", "data": "catalog", "message": {"chat": self.chat},
        }}, self.api)
        self.assertEqual(self.api.call_args_list[0].args, ("answerCallbackQuery",))
        self.assertEqual(self.api.call_args_list[1].kwargs["text"], "محصول نمونه: دفتر یادداشت")

    def test_group_start_is_ignored(self):
        handle_update({"message": {"chat": {"type": "group"}, "text": "/start"}}, self.api)
        self.api.assert_not_called()

    def test_invalid_token_never_calls_telegram(self):
        with patch("bot.telegram") as api, patch("builtins.print") as output:
            self.assertEqual(run_bot("fake-token"), 1)
        api.assert_not_called()
        self.assertNotIn("fake-token", str(output.call_args_list))

    def test_webhook_is_left_unchanged(self):
        with patch("bot.telegram", side_effect=[
            {"username": "example_bot"}, {"url": "https://example.invalid"},
        ]) as api, patch("builtins.print"):
            self.assertEqual(run_bot("1:fake"), 1)
        self.assertEqual([call.args[1] for call in api.call_args_list], ["getMe", "getWebhookInfo"])

    def test_polling_conflict_reports_failure(self):
        with patch("bot.telegram", side_effect=[
            {"username": "example_bot"}, {}, TelegramError(409),
        ]) as api, patch("builtins.print") as output:
            self.assertEqual(run_bot("1:fake"), 1)
        self.assertEqual(api.call_args.args[1], "getUpdates")
        self.assertNotIn("1:fake", str(output.call_args_list))
