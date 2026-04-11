import {
  useEffect,
  useMemo,
  useRef,
  useCallback,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { ArrowLeft, ArrowRight, ExternalLink, RefreshCcw } from "lucide-react";
import { browserLabelFromUrl, normalizeBrowserUrl } from "@/lib/browserTabs";
import type { BrowserTab as BrowserTabInfo } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  desktopBrowserBridge,
  hasDesktopBrowserBridge,
  type DesktopBrowserState,
} from "@/lib/desktopBrowser";
import { useBrowserTabStore } from "@/lib/stores/browserTabs";
import { useTabStore } from "@/lib/stores/tabs";

type Props = {
  tab: BrowserTabInfo;
  visible: boolean;
};

export default function BrowserTab({ tab, visible }: Props) {
  const isDesktop = hasDesktopBrowserBridge();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const inputFocusedRef = useRef(false);
  const previousUrlRef = useRef(tab.url);
  const initialUrlRef = useRef(tab.url);
  const ensureSession = useBrowserTabStore((state) => state.ensureSession);
  const syncNavigationState = useBrowserTabStore(
    (state) => state.syncNavigationState,
  );
  const setDraftUrl = useBrowserTabStore((state) => state.setDraftUrl);
  const setLoading = useBrowserTabStore((state) => state.setLoading);
  const setError = useBrowserTabStore((state) => state.setError);
  const setShowEmbedHelp = useBrowserTabStore(
    (state) => state.setShowEmbedHelp,
  );
  const bumpReloadKey = useBrowserTabStore((state) => state.bumpReloadKey);
  const removeSession = useBrowserTabStore((state) => state.removeSession);
  const session = useBrowserTabStore((state) => state.sessions[tab.id] ?? null);
  const setBrowserState = useTabStore((state) => state.setBrowserState);

  const canGoBack = isDesktop
    ? (session?.canGoBack ?? false)
    : tab.history_index > 0;
  const canGoForward = isDesktop
    ? (session?.canGoForward ?? false)
    : tab.history_index < tab.history.length - 1;
  const iframeKey = useMemo(
    () => `${tab.id}:${tab.url}:${session?.reloadKey ?? 0}`,
    [session?.reloadKey, tab.id, tab.url],
  );

  const applyDesktopState = useCallback(
    async (state: DesktopBrowserState) => {
      syncNavigationState(tab.id, state.canGoBack, state.canGoForward);
      setLoading(tab.id, state.isLoading);
      setError(tab.id, state.error);
      if (!inputFocusedRef.current) {
        setDraftUrl(tab.id, state.url);
      }
      setShowEmbedHelp(tab.id, false);

      const nextLabel = state.title?.trim()
        ? state.title.trim()
        : browserLabelFromUrl(state.url);

      try {
        await setBrowserState(tab.id, {
          label: nextLabel,
          url: state.url,
          history: state.history,
          historyIndex: state.historyIndex,
        });
      } catch {
        // Leave the current tab state alone if syncing back to the server fails.
      }
    },
    [
      setBrowserState,
      setDraftUrl,
      setError,
      setLoading,
      setShowEmbedHelp,
      syncNavigationState,
      tab.id,
    ],
  );

  useEffect(() => {
    ensureSession(
      tab.id,
      tab.url,
      tab.history_index > 0,
      tab.history_index < tab.history.length - 1,
    );
  }, [ensureSession, tab.history.length, tab.history_index, tab.id, tab.url]);

  useEffect(() => {
    return () => {
      removeSession(tab.id);
    };
  }, [removeSession, tab.id]);

  useEffect(() => {
    syncNavigationState(
      tab.id,
      tab.history_index > 0,
      tab.history_index < tab.history.length - 1,
    );

    if (
      !inputFocusedRef.current &&
      session?.draftUrl === previousUrlRef.current
    ) {
      setDraftUrl(tab.id, tab.url);
    }
    previousUrlRef.current = tab.url;
  }, [
    session?.draftUrl,
    setDraftUrl,
    syncNavigationState,
    tab.history.length,
    tab.history_index,
    tab.id,
    tab.url,
  ]);

  useEffect(() => {
    if (isDesktop) {
      return;
    }

    if (!session?.loading) {
      setShowEmbedHelp(tab.id, false);
      return;
    }

    const timeout = window.setTimeout(() => {
      setShowEmbedHelp(tab.id, true);
    }, 4000);

    return () => window.clearTimeout(timeout);
  }, [isDesktop, session?.loading, setShowEmbedHelp, tab.id]);

  useEffect(() => {
    if (!isDesktop) {
      return;
    }

    const bridge = desktopBrowserBridge();
    if (!bridge) {
      return;
    }

    let cancelled = false;
    void bridge
      .create({ tabId: tab.id, url: initialUrlRef.current })
      .then(({ state }) => {
        if (!cancelled) {
          void applyDesktopState(state);
        }
      });

    return () => {
      cancelled = true;
      bridge.destroy({ tabId: tab.id });
    };
  }, [applyDesktopState, isDesktop, tab.id]);

  useEffect(() => {
    if (!isDesktop) {
      return;
    }

    const bridge = desktopBrowserBridge();
    if (!bridge) {
      return;
    }

    return bridge.subscribe((state) => {
      if (state.tabId !== tab.id) {
        return;
      }

      void applyDesktopState(state);
    });
  }, [applyDesktopState, isDesktop, tab.id]);

  useEffect(() => {
    if (!isDesktop) {
      return;
    }

    const bridge = desktopBrowserBridge();
    if (!bridge) {
      return;
    }

    if (visible) {
      bridge.show({ tabId: tab.id });
    } else {
      bridge.hide({ tabId: tab.id });
    }
  }, [isDesktop, tab.id, visible]);

  useEffect(() => {
    if (!isDesktop || !visible) {
      return;
    }

    const bridge = desktopBrowserBridge();
    const host = hostRef.current;
    if (!bridge || !host) {
      return;
    }

    const updateBounds = () => {
      const rect = host.getBoundingClientRect();
      bridge.setBounds({
        tabId: tab.id,
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    };

    const observer = new ResizeObserver(() => updateBounds());
    observer.observe(host);
    updateBounds();
    window.addEventListener("resize", updateBounds);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
    };
  }, [isDesktop, tab.id, visible]);

  async function navigateTo(rawUrl: string) {
    let url: string;
    try {
      url = normalizeBrowserUrl(rawUrl);
    } catch (error) {
      setError(
        tab.id,
        error instanceof Error ? error.message : "Enter a valid URL.",
      );
      return;
    }

    setError(tab.id, null);
    setShowEmbedHelp(tab.id, false);
    setLoading(tab.id, true);
    setDraftUrl(tab.id, url);

    const nextHistory = [...tab.history.slice(0, tab.history_index + 1), url];
    const nextHistoryIndex = nextHistory.length - 1;
    await setBrowserState(tab.id, {
      label: browserLabelFromUrl(url),
      url,
      history: nextHistory,
      historyIndex: nextHistoryIndex,
    });

    if (isDesktop) {
      desktopBrowserBridge()?.navigate({ tabId: tab.id, url });
    }
  }

  async function goBack() {
    if (!canGoBack) {
      return;
    }

    if (isDesktop) {
      setLoading(tab.id, true);
      desktopBrowserBridge()?.goBack({ tabId: tab.id });
      return;
    }

    const nextIndex = tab.history_index - 1;
    const url = tab.history[nextIndex];
    setLoading(tab.id, true);
    await setBrowserState(tab.id, {
      label: browserLabelFromUrl(url),
      url,
      history: tab.history,
      historyIndex: nextIndex,
    });
  }

  async function goForward() {
    if (!canGoForward) {
      return;
    }

    if (isDesktop) {
      setLoading(tab.id, true);
      desktopBrowserBridge()?.goForward({ tabId: tab.id });
      return;
    }

    const nextIndex = tab.history_index + 1;
    const url = tab.history[nextIndex];
    setLoading(tab.id, true);
    await setBrowserState(tab.id, {
      label: browserLabelFromUrl(url),
      url,
      history: tab.history,
      historyIndex: nextIndex,
    });
  }

  function reload() {
    setLoading(tab.id, true);
    setError(tab.id, null);
    setShowEmbedHelp(tab.id, false);
    if (isDesktop) {
      desktopBrowserBridge()?.reload({ tabId: tab.id });
      return;
    }

    bumpReloadKey(tab.id);
  }

  function submitAddressBar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void navigateTo(session?.draftUrl ?? tab.url);
  }

  function handleAddressBarKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setDraftUrl(tab.id, tab.url);
      event.currentTarget.blur();
    }
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <form
        className="flex items-center gap-2 border-b px-3 py-2"
        onSubmit={submitAddressBar}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          disabled={!canGoBack}
          onClick={() => {
            void goBack();
          }}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Forward"
          disabled={!canGoForward}
          onClick={() => {
            void goForward();
          }}
        >
          <ArrowRight className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Reload"
          onClick={reload}
        >
          <RefreshCcw className="h-4 w-4" />
        </Button>
        <Input
          value={session?.draftUrl ?? tab.url}
          onChange={(event) => setDraftUrl(tab.id, event.target.value)}
          onFocus={() => {
            inputFocusedRef.current = true;
          }}
          onBlur={() => {
            inputFocusedRef.current = false;
            setDraftUrl(tab.id, tab.url);
          }}
          onKeyDown={handleAddressBarKeyDown}
          aria-label="Browser address"
          spellCheck={false}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Open in external browser"
          onClick={() => window.open(tab.url, "_blank", "noopener,noreferrer")}
        >
          <ExternalLink className="h-4 w-4" />
        </Button>
      </form>

      {session?.error ? (
        <div className="border-b bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {session.error}
        </div>
      ) : null}

      {!isDesktop && session?.showEmbedHelp ? (
        <div className="border-b bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          Some sites block embedding or won&apos;t fully sync navigation in the
          web app. Use the external-browser button if this page stays blank.
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {isDesktop ? (
          <div ref={hostRef} className="absolute inset-0 bg-background" />
        ) : (
          <iframe
            key={iframeKey}
            title={tab.label || tab.url}
            src={tab.url}
            className="absolute inset-0 h-full w-full border-0 bg-background"
            onLoad={() => {
              setLoading(tab.id, false);
              setError(tab.id, null);
              setShowEmbedHelp(tab.id, false);
            }}
          />
        )}

        {session?.loading ? (
          <div className="pointer-events-none absolute top-3 right-3 rounded-full border bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm">
            Loading…
          </div>
        ) : null}
      </div>
    </div>
  );
}
