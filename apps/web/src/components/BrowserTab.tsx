import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  RefreshCcw,
} from "lucide-react";
import {
  BLANK_BROWSER_URL,
  browserInputValue,
  browserLabelFromUrl,
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
import { useBrowserTabStore } from "@/lib/stores/browserTabs";
import { useTabStore } from "@/lib/stores/tabs";

type Props = {
  tab: BrowserTabInfo;
  visible: boolean;
};

const URL_INPUT_PROPS = {
  type: "text",
  inputMode: "url" as const,
  enterKeyHint: "go" as const,
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

async function probeNavigationTarget(url: string): Promise<boolean | string> {
  try {
    const response = await fetch(url, {
      method: "GET",
      mode: "cors",
      redirect: "follow",
      cache: "no-store",
    });

    if (response.url) {
      try {
        const resolvedUrl = new URL(response.url);
        if (
          resolvedUrl.protocol === "http:" ||
          resolvedUrl.protocol === "https:"
        ) {
          return resolvedUrl.toString();
        }
      } catch {
        // Fall through to the original probe URL when the final response URL
        // is not parseable for some reason.
      }
    }

    return true;
  } catch {
    // Many cross-origin sites reject CORS reads entirely. Fall back to a
    // best-effort reachability probe that still lets browser tabs open.
  }

  try {
    const response = await fetch(url, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
    });

    if (!response.url) {
      return true;
    }

    try {
      const resolvedUrl = new URL(response.url);
      if (
        resolvedUrl.protocol === "http:" ||
        resolvedUrl.protocol === "https:"
      ) {
        return resolvedUrl.toString();
      }
    } catch {
      // Fall back to the original probe URL when the browser does not expose
      // a parseable final response URL for no-cors requests.
    }

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

  const httpResult = await probeNavigationTarget(parsed.httpUrl);
  if (httpResult) {
    return typeof httpResult === "string" ? httpResult : parsed.httpUrl;
  }

  const httpsResult = await probeNavigationTarget(parsed.httpsUrl);
  if (httpsResult) {
    return typeof httpsResult === "string" ? httpsResult : parsed.httpsUrl;
  }

  return parsed.httpUrl;
}

export default function BrowserTab({ tab, visible }: Props) {
  const isDesktop = hasDesktopBrowserBridge();
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const inputFocusedRef = useRef(false);
  const previousUrlRef = useRef(tab.url);
  const [desktopCreateUrl] = useState(() => tab.url);
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

  const iframeKey = `${tab.id}:${tab.url}:${session?.reloadKey ?? 0}`;
  const errorMessageId = `${tab.id}-browser-error`;

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
    void bridge
      .create({ tabId: tab.id, url: desktopCreateUrl })
      .then(({ state }) => {
        if (!cancelled) {
          void applyDesktopState(state);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [applyDesktopState, desktopCreateUrl, isDesktop, tab.id]);

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

    const latestTab = useTabStore
      .getState()
      .tabs.find((candidate) => candidate.id === tab.id);
    if (!latestTab || latestTab.type !== "browser") {
      setLoading(tab.id, false);
      return;
    }

    const nextHistory = nextBrowserHistory(latestTab, url);
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
    <div className="flex h-full flex-col bg-background" data-browser-tab>
      <form
        className="flex items-center gap-2 border-b px-3 py-2"
        noValidate
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
          aria-invalid={session?.error ? true : undefined}
          aria-describedby={session?.error ? errorMessageId : undefined}
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
        <div
          id={errorMessageId}
          role="alert"
          className="border-b border-amber-500/20 bg-linear-to-r from-amber-500/12 via-amber-500/6 to-transparent px-3 py-2"
        >
          <div className="flex items-start gap-2 text-sm text-amber-950 dark:text-amber-100">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0">
              <p className="font-medium">Can&apos;t open that page</p>
              <p className="text-amber-900/80 dark:text-amber-100/80">
                {session.error}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {!isDesktop && session?.showEmbedHelp ? (
        <div className="border-b bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          Embedded pages in the web app are best-effort only. Some sites,
          including localhost previews, will load fine, others may block
          embedding or keep their own history. Open the page in your external
          browser if it behaves incorrectly here.
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {isDesktop ? (
          <div
            ref={hostRef}
            className="absolute inset-0 bg-background"
            data-browser-content
          />
        ) : (
          <iframe
            key={iframeKey}
            title={tab.label || tab.url}
            src={tab.url}
            className="absolute inset-0 h-full w-full border-0 bg-background"
            data-browser-content
            onLoad={() => {
              if (!session?.loading) {
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
