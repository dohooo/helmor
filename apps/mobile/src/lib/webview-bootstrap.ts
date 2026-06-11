import type { NativePairing } from "./pairing";

export type NativeSafeArea = {
	top: number;
	bottom: number;
};

export function companionWebViewUrl(pairing: NativePairing): string {
	const baseUrl = pairing.baseUrl.replace(/[#?].*$/, "").replace(/\/$/, "");
	return `${baseUrl}/#token=${encodeURIComponent(pairing.token)}`;
}

export function companionBootstrapScript(
	pairing: NativePairing,
	safeArea: NativeSafeArea,
): string {
	const token = JSON.stringify(pairing.token);
	const nativeSafeAreaScript = companionNativeSafeAreaScript(safeArea);

	return `
(function () {
  var token = ${token};
  var postDiagnostic = function (level, message, details) {
    try {
      if (!window.ReactNativeWebView) return;
      window.ReactNativeWebView.postMessage(
        JSON.stringify({
          type: "helmor:webview-diagnostic",
          level: level,
          message: message,
          details: details || null,
          href: window.location ? window.location.href : null,
          readyState: document ? document.readyState : null
        })
      );
    } catch (error) {}
  };
  var errorDetails = function (error) {
    if (!error) return null;
    return {
      name: error.name || null,
      message: error.message ? String(error.message) : String(error),
      stack: error.stack ? String(error.stack) : null
    };
  };
  var stringifyArg = function (arg) {
    try {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return (arg.stack || arg.message || String(arg));
      return JSON.stringify(arg);
    } catch (error) {
      return String(arg);
    }
  };

  postDiagnostic("info", "bootstrap:start", {
    tokenLength: token.length,
    hasCompanionGlobal: !!window.__HELMOR_COMPANION__
  });

  try {
    if (!window.__HELMOR_NATIVE_DIAGNOSTICS__) {
      window.__HELMOR_NATIVE_DIAGNOSTICS__ = true;
      var previousOnError = window.onerror;
      window.onerror = function (message, source, lineno, colno, error) {
        postDiagnostic("error", "window.onerror", {
          message: String(message),
          source: source || null,
          lineno: lineno || null,
          colno: colno || null,
          error: errorDetails(error)
        });
        if (typeof previousOnError === "function") {
          return previousOnError.apply(this, arguments);
        }
        return false;
      };
      window.addEventListener("unhandledrejection", function (event) {
        postDiagnostic("error", "unhandledrejection", {
          reason: errorDetails(event.reason) || stringifyArg(event.reason)
        });
      });
      ["log", "warn", "error"].forEach(function (level) {
        var original = console[level];
        if (typeof original !== "function") return;
        console[level] = function () {
          try {
            postDiagnostic(level === "log" ? "info" : level, "console." + level, {
              args: Array.prototype.slice.call(arguments).map(stringifyArg)
            });
          } catch (error) {}
          return original.apply(console, arguments);
        };
      });
      document.addEventListener("DOMContentLoaded", function () {
        try {
          postDiagnostic("info", "dom:content-loaded", {
            rootExists: !!document.getElementById("root"),
            bodyTextLength: document.body && document.body.innerText
              ? document.body.innerText.length
              : 0
          });
        } catch (error) {}
      });
      window.addEventListener("load", function () {
        try {
          postDiagnostic("info", "window:load", {
            rootChildCount: document.getElementById("root")
              ? document.getElementById("root").childNodes.length
              : null
          });
        } catch (error) {}
      });
    }
  } catch (error) {
    postDiagnostic("error", "diagnostics-install-failed", errorDetails(error));
  }

  try {
    var companion = window.__HELMOR_COMPANION__ || {};
    companion.token = token;
    window.__HELMOR_COMPANION__ = companion;
    postDiagnostic("info", "bootstrap:companion-global-ready", {
      hasToken: !!window.__HELMOR_COMPANION__.token
    });
  } catch (error) {
    postDiagnostic("error", "bootstrap:companion-global-failed", errorDetails(error));
  }

  try {
    window.localStorage.setItem("helmor.companion.pat", token);
    postDiagnostic("info", "bootstrap:local-storage-ready", {
      hasToken: window.localStorage.getItem("helmor.companion.pat") === token
    });
  } catch (error) {
    postDiagnostic("error", "bootstrap:local-storage-failed", errorDetails(error));
  }

  try {
    document.cookie = "helmor_companion_pat=" + token + "; path=/; SameSite=Strict";
    postDiagnostic("info", "bootstrap:cookie-written", {
      hasCookie: document.cookie.indexOf("helmor_companion_pat=") !== -1
    });
  } catch (error) {
    postDiagnostic("error", "bootstrap:cookie-failed", errorDetails(error));
  }

  try {
    var viewport = document.querySelector('meta[name="viewport"]');
    if (!viewport) {
      viewport = document.createElement("meta");
      viewport.setAttribute("name", "viewport");
      document.head.appendChild(viewport);
    }
    viewport.setAttribute(
      "content",
      "width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"
    );
    document.documentElement.style.webkitTextSizeAdjust = "100%";
    document.documentElement.style.overscrollBehavior = "none";
    if (document.body) document.body.style.overscrollBehavior = "none";
    ${nativeSafeAreaScript}
    postDiagnostic("info", "bootstrap:viewport-ready", {});
  } catch (error) {
    postDiagnostic("error", "bootstrap:viewport-failed", errorDetails(error));
  }

  try {
    if (!window.__HELMOR_NATIVE_THEME_OBSERVER__) {
      window.__HELMOR_NATIVE_THEME_OBSERVER__ = true;

      var normalizeColor = function (color) {
        if (!color) return null;
        var canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        var context = canvas.getContext("2d");
        if (!context) return color;
        context.fillStyle = "rgba(1, 2, 3, 0.5)";
        var sentinel = context.fillStyle;
        context.fillStyle = color;
        if (context.fillStyle === sentinel) return null;
        context.clearRect(0, 0, 1, 1);
        context.fillRect(0, 0, 1, 1);
        var pixel = context.getImageData(0, 0, 1, 1).data;
        if (pixel[3] === 0) return null;
        if (pixel[3] === 255) {
          return "rgb(" + pixel[0] + ", " + pixel[1] + ", " + pixel[2] + ")";
        }
        return "rgba(" + pixel[0] + ", " + pixel[1] + ", " + pixel[2] + ", " + (pixel[3] / 255).toFixed(3) + ")";
      };

      var sendBackgroundColor = function () {
        try {
          var rootStyle = window.getComputedStyle(document.documentElement);
          var bodyStyle = document.body ? window.getComputedStyle(document.body) : null;
          var color =
            rootStyle.getPropertyValue("--bg-base").trim() ||
            rootStyle.getPropertyValue("--background").trim() ||
            rootStyle.backgroundColor ||
            (bodyStyle ? bodyStyle.backgroundColor : "");
          var normalized = normalizeColor(color);
          if (normalized && window.ReactNativeWebView) {
            window.ReactNativeWebView.postMessage(
              JSON.stringify({
                type: "helmor:background-color",
                value: normalized,
              })
            );
          }
        } catch (error) {}
      };

      sendBackgroundColor();
      window.addEventListener("load", sendBackgroundColor);
      var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
      if (media && typeof media.addEventListener === "function") {
        media.addEventListener("change", sendBackgroundColor);
      } else if (media && typeof media.addListener === "function") {
        media.addListener(sendBackgroundColor);
      }
      new MutationObserver(sendBackgroundColor).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
      postDiagnostic("info", "bootstrap:theme-observer-ready", {});
    }
  } catch (error) {
    postDiagnostic("error", "bootstrap:theme-observer-failed", errorDetails(error));
  }
})();
true;
`;
}

export function companionNativeSafeAreaScript(
	safeArea: NativeSafeArea,
): string {
	const safeAreaJson = JSON.stringify({
		top: Math.max(safeArea.top, 0),
		bottom: Math.max(safeArea.bottom, 0),
	});

	return `
(function () {
  var safeArea = ${safeAreaJson};
  document.documentElement.setAttribute("data-helmor-native-app", "ios");
  document.documentElement.style.setProperty("--helmor-native-safe-area-top", safeArea.top + "px");
  document.documentElement.style.setProperty("--helmor-native-safe-area-bottom", safeArea.bottom + "px");
  window.__HELMOR_NATIVE_APP__ = { platform: "ios", safeArea: safeArea };
})();
true;
`;
}
