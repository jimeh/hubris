import {
  CircleAlert,
  CircleCheckBig,
  Info,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { Toaster } from "sonner";
import { useSettingsStore } from "@/lib/stores/settings";

export default function ToastViewport() {
  const themeType = useSettingsStore((state) => state.activeTheme?.type);
  const prefersLight = useSettingsStore((state) => state.prefersLight);
  const theme = themeType ? themeType : prefersLight ? "light" : "dark";

  return (
    <Toaster
      theme={theme}
      position="bottom-right"
      closeButton
      richColors
      visibleToasts={3}
      expand={false}
      offset={16}
      icons={{
        success: <CircleCheckBig className="size-4" />,
        info: <Info className="size-4" />,
        warning: <TriangleAlert className="size-4" />,
        error: <CircleAlert className="size-4" />,
        loading: <LoaderCircle className="size-4 animate-spin" />,
      }}
      toastOptions={{
        duration: 4_000,
        unstyled: false,
        classNames: {
          toast:
            "group rounded-lg border bg-popover/96 text-popover-foreground shadow-lg backdrop-blur-sm",
          title: "text-[13px] font-medium tracking-tight",
          description: "text-[12px] leading-5 text-muted-foreground",
          closeButton:
            "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
        },
      }}
    />
  );
}
