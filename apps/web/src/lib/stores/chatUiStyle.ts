import { create } from "zustand";

export type ChatUiStyle = "classic" | "copilotkit";

const STORAGE_KEY = "hubris.chatUiStyle";

type ChatUiStyleStore = {
  style: ChatUiStyle;
  setStyle: (style: ChatUiStyle) => void;
};

function isChatUiStyle(value: string | null): value is ChatUiStyle {
  return value === "classic" || value === "copilotkit";
}

function defaultChatUiStyle(): ChatUiStyle {
  if (typeof window === "undefined") {
    return "classic";
  }

  if (window.location.hostname.startsWith("copilotkit-chat-ui.")) {
    return "copilotkit";
  }

  const stored = window.localStorage.getItem(STORAGE_KEY);
  return isChatUiStyle(stored) ? stored : "classic";
}

export const useChatUiStyle = create<ChatUiStyleStore>((set) => ({
  style: defaultChatUiStyle(),
  setStyle: (style) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, style);
    }
    set({ style });
  },
}));
