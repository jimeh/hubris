import { create } from "zustand";

export type ChatUiStyle = "classic" | "copilotkit";
export type CopilotKitThemeMode = "hubris" | "stock";

const STORAGE_KEY = "hubris.chatUiStyle";
const COPILOTKIT_THEME_STORAGE_KEY = "hubris.copilotKitThemeMode";

type ChatUiStyleStore = {
  style: ChatUiStyle;
  copilotKitThemeMode: CopilotKitThemeMode;
  setStyle: (style: ChatUiStyle) => void;
  setCopilotKitThemeMode: (mode: CopilotKitThemeMode) => void;
};

function isChatUiStyle(value: string | null): value is ChatUiStyle {
  return value === "classic" || value === "copilotkit";
}

function isCopilotKitThemeMode(
  value: string | null,
): value is CopilotKitThemeMode {
  return value === "hubris" || value === "stock";
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

function defaultCopilotKitThemeMode(): CopilotKitThemeMode {
  if (typeof window === "undefined") {
    return "hubris";
  }

  const stored = window.localStorage.getItem(COPILOTKIT_THEME_STORAGE_KEY);
  return isCopilotKitThemeMode(stored) ? stored : "hubris";
}

export const useChatUiStyle = create<ChatUiStyleStore>((set) => ({
  style: defaultChatUiStyle(),
  copilotKitThemeMode: defaultCopilotKitThemeMode(),
  setStyle: (style) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, style);
    }
    set({ style });
  },
  setCopilotKitThemeMode: (mode) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(COPILOTKIT_THEME_STORAGE_KEY, mode);
    }
    set({ copilotKitThemeMode: mode });
  },
}));
