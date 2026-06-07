import type { NativePairing } from "./pairing";

export type NativeSafeArea = {
	top: number;
	bottom: number;
};

export function companionBootstrapScript(
	pairing: NativePairing,
	safeArea: NativeSafeArea,
): string {
	const token = JSON.stringify(pairing.token);
	const nativeSafeAreaScript = companionNativeSafeAreaScript(safeArea);

	return `
(function () {
  var token = ${token};
  try {
    window.localStorage.setItem("helmor.companion.pat", token);
  } catch (error) {}

  try {
    document.cookie = "helmor_companion_pat=" + token + "; path=/; SameSite=Strict";
  } catch (error) {}

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
  } catch (error) {}

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
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", sendBackgroundColor);
      new MutationObserver(sendBackgroundColor).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
    }
  } catch (error) {}
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
