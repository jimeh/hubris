import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { ArrowLeft, ArrowRight, ExternalLink, RefreshCcw } from "lucide-react";
import {
  BLANK_BROWSER_URL,
  browserFrameSrc,
  browserInputValue,
  browserLabelFromUrl,
  decodeBrowserPreviewProxyUrl,
  isLoopbackBrowserUrl,
  parseBrowserUrlInput,
} from "@/lib/browserTabs";
import type { BrowserTab as BrowserTabInfo } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  desktopBrowserBridge,
  hasDesktopBrowserBridge,
  type DesktopBrowserState,
} from "@/lib/desktopBrowser";
import { useBrowserSurfaceOcclusionStore } from "@/lib/stores/browserSurfaceOcclusion";
import { useBrowserTabStore } from "@/lib/stores/browserTabs";
import { useTabStore } from "@/lib/stores/tabs";

type Props = {
  tab: BrowserTabInfo;
  visible: boolean;
};

const URL_INPUT_PROPS = {
  type: "url",
  inputMode: "url" as const,
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "none" as const,
  spellCheck: false,
  name: "browser-url",
  "data-1p-ignore": "true",
  "data-lpignore": "true",
};

function nextBrowserHistory(
  tab: BrowserTabInfo,
  url: string,
): Pick<BrowserTabInfo, "history" | "history_index"> {
  const { history, history_index: historyIndex } = tab;
  if (history[historyIndex] === url) {
    return { history, history_index: historyIndex };
  }
  if (historyIndex > 0 && history[historyIndex - 1] === url) {
    return { history, history_index: historyIndex - 1 };
  }
  if (historyIndex + 1 < history.length && history[historyIndex + 1] === url) {
    return { history, history_index: historyIndex + 1 };
  }

  return {
    history: [...history.slice(0, historyIndex + 1), url],
    history_index: historyIndex + 1,
  };
}

async function probeNavigationTarget(url: string): Promise<boolean> {
  try {
    await fetch(url, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
    });
    return true;
  } catch {
    return false;
  }
}

async function resolveNavigationUrl(rawUrl: string): Promise<string> {
  const parsed = parseBrowserUrlInput(rawUrl);
  if (parsed.kind === "blank") {
    throw new Error("Enter a valid URL.");
  }
  if (parsed.kind === "absolute") {
    return parsed.url;
  }

  const httpAvailable = await probeNavigationTarget(parsed.httpUrl);
  if (httpAvailable) {
    return parsed.httpUrl;
  }

  const httpsAvailable = await probeNavigationTarget(parsed.httpsUrl);
  if (httpsAvailable) {
    return parsed.httpsUrl;
  }

  return parsed.httpUrl;
}

export default function BrowserTab({ tab, visible }: Props) {
  const isDesktop = hasDesktopBrowserBridge();
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const inputFocusedRef = useRef(false);
  const previousUrlRef = useRef(tab.url);
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
  const isOccluded = useBrowserSurfaceOcclusionStore(
    (state) => Object.keys(state.reasons).length > 0,
  );

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
  const frameSrc = useMemo(() => browserFrameSrc(tab.url), [tab.url]);
  const isLoopbackPreview = useMemo(
    () => isLoopbackBrowserUrl(tab.url),
    [tab.url],
  );

  const syncWebIframeState = useCallback(async () => {
    if (!visible || isDesktop || !isLoopbackPreview) {
      return;
    }

    const frame = iframeRef.current;
    const href = frame?.contentWindow?.location.href;
    if (!href) {
      return;
    }

    const nextUrl = decodeBrowserPreviewProxyUrl(href);
    if (!nextUrl) {
      return;
    }

    const nextTitle = frame?.contentDocument?.title?.trim();
    const nextHistory = nextBrowserHistory(tab, nextUrl);
    setLoading(tab.id, false);
    setError(tab.id, null);
    setShowEmbedHelp(tab.id, false);
    if (!inputFocusedRef.current) {
      setDraftUrl(tab.id, browserInputValue(nextUrl));
    }

    if (
      nextUrl === tab.url &&
      nextHistory.history_index === tab.history_index &&
      nextHistory.history.length === tab.history.length
    ) {
      return;
    }

    await setBrowserState(tab.id, {
      label: nextTitle || browserLabelFromUrl(nextUrl),
      url: nextUrl,
      history: nextHistory.history,
      historyIndex: nextHistory.history_index,
    });
  }, [
    isDesktop,
    isLoopbackPreview,
    setBrowserState,
    setDraftUrl,
    setError,
    setLoading,
    setShowEmbedHelp,
    tab,
    visible,
  ]);

  const applyDesktopState = useCallback(
    async (state: DesktopBrowserState) => {
      syncNavigationState(tab.id, state.canGoBack, state.canGoForward);
      setLoading(tab.id, state.isLoading);
      setError(tab.id, state.error);
      if (!inputFocusedRef.current) {
        setDraftUrl(tab.id, browserInputValue(state.url));
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
      browserInputValue(tab.url),
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

    const displayUrl = browserInputValue(tab.url);
    if (
      !inputFocusedRef.current &&
      session?.draftUrl === browserInputValue(previousUrlRef.current)
    ) {
      setDraftUrl(tab.id, displayUrl);
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
    if (isDesktop || !visible) {
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
  }, [isDesktop, session?.loading, setShowEmbedHelp, tab.id, visible]);

  useEffect(() => {
    if (!visible || tab.url !== BLANK_BROWSER_URL) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      addressInputRef.current?.focus();
      addressInputRef.current?.select();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [tab.url, visible]);

  useEffect(() => {
    if (!isDesktop) {
      return;
    }

    const bridge = desktopBrowserBridge();
    if (!bridge) {
      return;
    }

    let cancelled = false;
    void bridge.create({ tabId: tab.id, url: tab.url }).then(({ state }) => {
      if (!cancelled) {
        void applyDesktopState(state);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [applyDesktopState, isDesktop, tab.id, tab.url]);

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

    if (visible && !isOccluded) {
      bridge.show({ tabId: tab.id });
    } else {
      bridge.hide({ tabId: tab.id });
    }
  }, [isDesktop, isOccluded, tab.id, visible]);

  useEffect(() => {
    if (!isDesktop || !visible || isOccluded) {
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
  }, [isDesktop, isOccluded, tab.id, visible]);

  useEffect(() => {
    if (isDesktop || !visible) {
      return;
    }

    const interval = window.setInterval(() => {
      void syncWebIframeState();
    }, 400);

    return () => window.clearInterval(interval);
  }, [isDesktop, syncWebIframeState, visible]);

  async function navigateTo(rawUrl: string) {
    let url: string;
    try {
      url = await resolveNavigationUrl(rawUrl);
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
    setDraftUrl(tab.id, browserInputValue(url));

    const nextHistory = nextBrowserHistory(tab, url);
    await setBrowserState(tab.id, {
      label: browserLabelFromUrl(url),
      url,
      history: nextHistory.history,
      historyIndex: nextHistory.history_index,
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
    void navigateTo(session?.draftUrl ?? browserInputValue(tab.url));
  }

  function handleAddressBarKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setDraftUrl(tab.id, browserInputValue(tab.url));
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
          ref={addressInputRef}
          {...URL_INPUT_PROPS}
          value={session?.draftUrl ?? browserInputValue(tab.url)}
          onChange={(event) => setDraftUrl(tab.id, event.target.value)}
          onFocus={() => {
            inputFocusedRef.current = true;
          }}
          onBlur={() => {
            inputFocusedRef.current = false;
            setDraftUrl(tab.id, browserInputValue(tab.url));
          }}
          onKeyDown={handleAddressBarKeyDown}
          placeholder="Enter a URL"
          aria-label="Browser address"
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
          Some sites block embedding in the web app, and direct external pages
          still have limited history sync. Open this page in your external
          browser if it refuses to load here.
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {isDesktop ? (
          <div ref={hostRef} className="absolute inset-0 bg-background" />
        ) : (
          <iframe
            ref={iframeRef}
            key={iframeKey}
            title={tab.label || tab.url}
            src={frameSrc}
            className="absolute inset-0 h-full w-full border-0 bg-background"
            onLoad={() => {
              if (isLoopbackPreview) {
                void syncWebIframeState();
                return;
              }

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
