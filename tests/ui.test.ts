import { describe, expect, it, vi } from "vitest";
import { InlineKeyboard } from "grammy";
import type { BotContext } from "../src/bot/context.js";
import { deleteReplyPrompt, editMessageSafely } from "../src/bot/ui.js";

function callbackContext(overrides: Record<string, unknown> = {}): BotContext {
  return {
    chat: { id: 42, type: "private" },
    callbackQuery: { message: { message_id: 7 } },
    api: {
      deleteMessage: vi.fn(async () => true),
      sendMessage: vi.fn(async () => ({ message_id: 8 })),
    },
    editMessageText: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as BotContext;
}

describe("Telegram screen cleanup", () => {
  it("deletes the callback screen and sends the replacement", async () => {
    const ctx = callbackContext();
    await editMessageSafely(ctx, "Next screen", new InlineKeyboard().text("Home", "menu:home"));

    expect(ctx.api.deleteMessage).toHaveBeenCalledWith(42, 7);
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(42, "Next screen", expect.objectContaining({ reply_markup: expect.any(InlineKeyboard) }));
    expect(ctx.editMessageText).not.toHaveBeenCalled();
  });

  it("removes a matching force-reply prompt without touching unrelated messages", async () => {
    const deleteMessage = vi.fn(async () => true);
    const ctx = callbackContext({
      callbackQuery: undefined,
      message: {
        message_id: 12,
        reply_to_message: { message_id: 11, text: "Prompt" },
      },
      api: { deleteMessage },
    });
    await deleteReplyPrompt(ctx, "Prompt");
    expect(deleteMessage).toHaveBeenCalledWith(42, 11);

    deleteMessage.mockClear();
    await deleteReplyPrompt(ctx, "Other prompt");
    expect(deleteMessage).not.toHaveBeenCalled();
  });
});
