import {Command} from "commander";

type TelegramResponse = {
  ok: boolean;
  result?: {
    message_id?: number;
  };
  description?: string;
};

const program = new Command();

program
  .name("glyphmark")
  .description("GlyphMark CLI")
  .command("telegram")
  .description("Send a Telegram message")
  .argument("<chatId>", "Telegram Chat ID")
  .argument("<message>", "Message text to send")
  .action(async (chatId: string, message: string) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.error("Error: TELEGRAM_BOT_TOKEN is not set in the environment variables.");
      process.exit(1);
    }

    if (!chatId || !message) {
      console.error("Error: Both chatId and message are required.");
      process.exit(1);
    }

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message
      })
    });

    const data: TelegramResponse = await response.json();

    if (!response.ok || !data.ok) {
        const detail = data.description ?? response.statusText;
        console.error(`Telegram API request failed: ${detail}`);
        process.exit(1);
    }

    const messageId = data.result?.message_id;

    console.log(`Sent Telegram message to chat ${chatId}`);

    if (messageId !== undefined) {
      console.log(` Telegram message ID: ${messageId}`);
    }
  });

program.parseAsync(process.argv);
